import { describe, expect, it } from "vitest";
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { toAISdkStream } from "@mastra/ai-sdk";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  readUIMessageStream,
  type UIMessage,
} from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { z } from "zod";

// The seam this file exists for: `@mastra/ai-sdk` bridges a Mastra agent stream
// into the AI SDK's UI-message chunk protocol, and the two packages version
// independently. `toAISdkStream` still defaults to the v5 protocol, so the app
// asks for `version: "v6"` — the shape the installed `ai` major consumes.
// Nothing in the app's own code catches a regression here: the route hands the
// converted stream straight to `createUIMessageStream` and the client hands it
// to `useChat`, so a protocol drift shows up as a silently blank transcript
// rather than as a build or type failure.
//
// So this drives the real conversion end to end — Mastra agent →
// toAISdkStream → createUIMessageStream → SSE bytes → the same reader `useChat`
// uses — and asserts both things the UI renders: streamed text, and the
// `tool-<name>` step parts (app/chat.tsx).

// `ai` doesn't re-export the provider-spec stream part type and
// @ai-sdk/provider isn't a direct dependency, so recover it from the mock
// model's own signature. Without an explicit annotation the chunk-builder
// helpers below infer a widened union and stop matching `doStream`.
type StreamPart =
  MockLanguageModelV4["doStream"] extends (
    ...args: never[]
  ) => PromiseLike<{ stream: ReadableStream<infer P> }>
    ? P
    : never;

const lookupTool = createTool({
  id: "lookup",
  description: "Look up a CVE.",
  inputSchema: z.object({ cve: z.string() }),
  outputSchema: z.object({ text: z.string() }),
  execute: async () => ({ text: "listed in KEV" }),
});

function textModel(deltas: string[]) {
  return new MockLanguageModelV4({
    doStream: async () => ({ stream: simulateReadableStream({ chunks: textChunks(deltas) }) }),
  });
}

// Two-step model: a tool call, then the text answer once the result comes back.
function toolThenTextModel(deltas: string[]) {
  let step = 0;
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: step++ === 0 ? toolCallChunks() : textChunks(deltas),
      }),
    }),
  });
}

function textChunks(deltas: string[]): StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t1" },
    ...deltas.map((delta) => ({ type: "text-delta" as const, id: "t1", delta })),
    { type: "text-end", id: "t1" },
    { type: "finish", finishReason: FINISH_STOP, usage: USAGE },
  ];
}

function toolCallChunks(): StreamPart[] {
  const input = '{"cve":"CVE-2024-1234"}';
  return [
    { type: "stream-start", warnings: [] },
    { type: "tool-input-start", id: "c1", toolName: "lookup" },
    { type: "tool-input-delta", id: "c1", delta: input },
    { type: "tool-input-end", id: "c1" },
    { type: "tool-call", toolCallId: "c1", toolName: "lookup", input },
    { type: "finish", finishReason: FINISH_TOOL_CALLS, usage: USAGE },
  ];
}

// Provider spec v4 shapes: finishReason is { unified, raw } and usage is
// nested per-token-kind — both changed from the flat v2 forms the previous
// AI SDK major used.
const FINISH_STOP = { unified: "stop", raw: "stop" } as const;
const FINISH_TOOL_CALLS = { unified: "tool-calls", raw: "tool_use" } as const;
const USAGE = {
  inputTokens: { total: 7, noCache: 7, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 3, text: 3, reasoning: 0 },
};

function userMessage(text: string): UIMessage {
  return { id: "m1", role: "user", parts: [{ type: "text", text }] };
}

// Mirrors app/api/chat/route.ts: agent.stream(...) → toAISdkStream(version v6)
// merged into a UI message stream → served as the SSE response.
async function runChatRoute(
  agent: Agent,
  messages: UIMessage[],
  onFinish?: (event: { totalUsage: { inputTokens?: number; outputTokens?: number } }) => void,
): Promise<Response> {
  const stream = await agent.stream(await convertToModelMessages(messages), { onFinish });
  const uiMessageStream = createUIMessageStream({
    originalMessages: messages,
    execute: ({ writer }) => {
      writer.merge(toAISdkStream(stream, { from: "agent", version: "v6" }));
    },
  });
  return createUIMessageStreamResponse({ stream: uiMessageStream });
}

// Re-parses the SSE body the way the client does, so the assertions cover the
// serialized wire format and not just the in-process chunk objects.
async function readAssistantMessage(response: Response): Promise<UIMessage> {
  const chunks = response.body!.pipeThrough(new TextDecoderStream()).pipeThrough(sseToChunks());
  let last: UIMessage | undefined;
  for await (const message of readUIMessageStream({ stream: chunks })) {
    last = message;
  }
  if (!last) throw new Error("stream produced no assistant message");
  return last;
}

// Minimal `data: {...}` SSE reader — enough for the single-response streams here.
function sseToChunks() {
  let buffer = "";
  return new TransformStream<string, never>({
    transform(text, controller) {
      buffer += text;
      let index: number;
      while ((index = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6);
          if (payload === "[DONE]") continue;
          controller.enqueue(JSON.parse(payload));
        }
      }
    },
  });
}

function textOf(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

describe("Mastra → AI SDK UI stream bridge", () => {
  it("streams the agent's text through to the client protocol", async () => {
    const agent = new Agent({
      id: "bridge-text",
      name: "bridge-text",
      instructions: "test",
      model: textModel(["CVE-2024-", "1234 is ", "in KEV."]),
    });

    const response = await runChatRoute(agent, [userMessage("what's in KEV?")]);

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const message = await readAssistantMessage(response);
    expect(message.role).toBe("assistant");
    expect(textOf(message)).toBe("CVE-2024-1234 is in KEV.");
  });

  // The provider spec now reports usage as { inputTokens: { total, ... } }
  // rather than a flat token count, and the rate limiter bills on Mastra's
  // normalized `event.totalUsage` in the route's onFinish. If that flattening
  // ever regresses to undefined the route silently records 0 tokens for every
  // request and the daily limit stops metering — no error, no failing build.
  it("reports flat token counts on the onFinish event the rate limiter bills", async () => {
    const agent = new Agent({
      id: "bridge-usage",
      name: "bridge-usage",
      instructions: "test",
      model: textModel(["ok"]),
    });

    let usage: { inputTokens?: number; outputTokens?: number } | undefined;
    const response = await runChatRoute(agent, [userMessage("hi")], (event) => {
      usage = event.totalUsage;
    });
    // onFinish fires in-band as the stream is consumed, so drain it first.
    await readAssistantMessage(response);

    expect(usage?.inputTokens).toBe(7);
    expect(usage?.outputTokens).toBe(3);
  });

  it("surfaces a tool call as the tool-<name> part app/chat.tsx renders", async () => {
    const agent = new Agent({
      id: "bridge-tool",
      name: "bridge-tool",
      instructions: "test",
      model: toolThenTextModel(["Yes."]),
      tools: { lookup: lookupTool },
    });

    const message = await readAssistantMessage(
      await runChatRoute(agent, [userMessage("is CVE-2024-1234 in KEV?")]),
    );

    // ToolStep keys off `part.type === "tool-<name>"` and `part.state`.
    const toolPart = message.parts.find((part) => part.type === "tool-lookup");
    expect(toolPart).toBeDefined();
    expect((toolPart as { state?: string }).state).toBe("output-available");
    expect((toolPart as { output?: unknown }).output).toEqual({ text: "listed in KEV" });
    expect(textOf(message)).toBe("Yes.");
  });
});
