import { describe, it, expect } from "vitest";
import {
  classifyChatError,
  describeChatError,
  isAdvisory,
  tagged,
  toStreamErrorText,
} from "./chat-errors";

// The real payload that reached the browser as a wall of JSON: Mastra's default
// stream onError JSON.stringify's the provider error object, so the user saw the
// message, the AI SDK class name, and a full internal stack trace.
const CREDIT_BLOB = JSON.stringify({
  message:
    "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
  name: "AI_APICallError",
  stack:
    "AI_APICallError: Your credit balance is too low ...\n    at /app/.next/server/app/api/chat/route.js:106:13854",
  url: "https://api.anthropic.com/v1/messages",
  statusCode: 400,
  isRetryable: false,
});

describe("classifyChatError", () => {
  it("classifies the spent-credit payload despite its 400 status", () => {
    expect(classifyChatError(CREDIT_BLOB)).toBe("provider-credit");
    expect(classifyChatError(JSON.parse(CREDIT_BLOB))).toBe("provider-credit");
  });

  it("classifies an Error instance by message", () => {
    expect(classifyChatError(new Error("insufficient_quota for this org"))).toBe("provider-credit");
  });

  it("distinguishes a rejected API key from an expired session", () => {
    expect(classifyChatError({ message: "invalid x-api-key", statusCode: 401 })).toBe(
      "provider-auth",
    );
    expect(classifyChatError({ message: "Unauthorized.", statusCode: 401 })).toBe(
      "session-expired",
    );
  });

  it("classifies throttling, overload, context and network failures", () => {
    expect(classifyChatError({ statusCode: 429, message: "rate_limit_error" })).toBe(
      "provider-rate-limit",
    );
    expect(classifyChatError({ statusCode: 529, message: "Overloaded" })).toBe(
      "provider-overloaded",
    );
    expect(classifyChatError(new Error("prompt is too long: 210000 tokens"))).toBe(
      "context-length",
    );
    expect(classifyChatError(new TypeError("Failed to fetch"))).toBe("network");
  });

  it("finds the cause inside a wrapper", () => {
    const wrapped = { message: "stream failed", cause: { message: "credit balance too low" } };
    expect(classifyChatError(wrapped)).toBe("provider-credit");
  });

  it("falls back to unknown, and survives junk input", () => {
    expect(classifyChatError(new Error("boom"))).toBe("unknown");
    expect(classifyChatError(null)).toBe("unknown");
    expect(classifyChatError(undefined)).toBe("unknown");
    expect(classifyChatError("")).toBe("unknown");
    expect(classifyChatError(42)).toBe("unknown");
  });

  it("does not recurse forever on a self-referential cause chain", () => {
    const a: Record<string, unknown> = { message: "a" };
    a.cause = a;
    expect(classifyChatError(a)).toBe("unknown");
  });
});

describe("toStreamErrorText", () => {
  it("emits tagged, user-safe text with no provider internals", () => {
    const text = toStreamErrorText(CREDIT_BLOB);
    expect(text.startsWith("[vc:provider-credit] ")).toBe(true);
    expect(text).not.toMatch(/stack|api\.anthropic\.com|route\.js|AI_APICallError/);
  });
});

describe("describeChatError", () => {
  it("round-trips a tagged message, keeping the server-authored detail", () => {
    const info = describeChatError(toStreamErrorText(CREDIT_BLOB));
    expect(info.kind).toBe("provider-credit");
    expect(info.title).toBe("Assistant temporarily unavailable");
    expect(info.detail).toMatch(/out of credit/);
    expect(info.retryable).toBe(false);
    expect(info.technical).toBeUndefined();
  });

  it("keeps the verbatim daily-limit sentence, which names the actual limit", () => {
    const msg = "You've reached your daily limit of 20 queries. Try again tomorrow.";
    for (const input of [msg, tagged("daily-limit", msg)]) {
      const info = describeChatError(input);
      expect(info.kind).toBe("daily-limit");
      expect(info.detail).toBe(msg);
      expect(info.retryable).toBe(false);
      expect(isAdvisory(info.kind)).toBe(true);
    }
  });

  it("classifies untagged raw payloads rather than rendering them verbatim", () => {
    const info = describeChatError(CREDIT_BLOB);
    expect(info.kind).toBe("provider-credit");
    expect(info.detail).not.toContain("stack");
    expect(info.technical).toBeUndefined();
  });

  it("retains the raw text only when the error stays unclassified", () => {
    const info = describeChatError("kaboom");
    expect(info.kind).toBe("unknown");
    expect(info.technical).toBe("kaboom");
    expect(info.retryable).toBe(true);
  });

  it("ignores an unrecognized tag and classifies the remainder", () => {
    const info = describeChatError("[vc:not-a-kind] credit balance is too low");
    expect(info.kind).toBe("provider-credit");
  });

  it("handles a missing message", () => {
    expect(describeChatError(undefined).kind).toBe("unknown");
    expect(describeChatError(undefined).technical).toBeUndefined();
  });

  it("marks faults non-advisory and transient conditions advisory", () => {
    expect(isAdvisory("provider-credit")).toBe(false);
    expect(isAdvisory("provider-overloaded")).toBe(true);
    expect(isAdvisory("network")).toBe(true);
  });
});
