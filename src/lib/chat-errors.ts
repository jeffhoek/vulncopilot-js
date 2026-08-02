// User-facing classification of chat failures.
//
// Two very different producers feed the chat transcript's error slot:
//   * non-ok responses from /api/chat (auth, rate limit, bad body), whose body
//     text `useChat` surfaces as `error.message`; and
//   * `error` chunks inside an otherwise-200 SSE stream — the provider call can
//     fail *after* the response headers are committed (mid-stream), so it can
//     only be reported in-band.
//
// Left alone, the second path is ugly and leaky: Mastra's default stream
// `onError` JSON.stringify's the provider error payload, so a spent Anthropic
// credit balance rendered as a wall of JSON complete with an internal stack
// trace and `/app/.next/server/...` paths. This module maps any raw error to a
// small set of kinds with a written explanation, and the route emits only the
// safe text (full error still goes to the server log).
//
// Wire format: the route prefixes the text it puts on the stream with a
// `[vc:<kind>]` tag so the client can pick the right treatment (icon, tone,
// retry affordance) without re-deriving it from prose. Untagged text — an older
// server, a transport-level failure, a raw provider blob — is classified
// client-side by the same matcher, so nothing is ever rendered verbatim as
// "Error: {…}" again.

export type ChatErrorKind =
  | "daily-limit"
  | "provider-credit"
  | "provider-auth"
  | "provider-rate-limit"
  | "provider-overloaded"
  | "context-length"
  | "network"
  | "session-expired"
  | "unknown";

export interface ChatErrorInfo {
  kind: ChatErrorKind;
  /** Short headline, e.g. "Assistant temporarily unavailable". */
  title: string;
  /** One or two sentences telling the user what happened and what to do. */
  detail: string;
  /** Whether re-sending the same question could plausibly succeed. */
  retryable: boolean;
  /** Raw text, kept only when we could not classify it (shown collapsed). */
  technical?: string;
}

interface Presentation {
  title: string;
  detail: string;
  retryable: boolean;
  /** Advisory (expected, self-resolving) rather than a fault. */
  advisory?: boolean;
}

// Wording note: these are read by an operator-ish audience (the app is gated to
// an allow-list), so they name the actual cause and the actual remedy — but not
// provider internals, URLs, or stack frames.
const PRESENTATION: Record<ChatErrorKind, Presentation> = {
  "daily-limit": {
    title: "Daily limit reached",
    detail: "You've used up today's query allowance. Try again tomorrow.",
    retryable: false,
    advisory: true,
  },
  "provider-credit": {
    title: "Assistant temporarily unavailable",
    detail:
      "The Anthropic API account backing this app is out of credit, so no new answers can be generated. An administrator needs to top it up in the Anthropic Console under Plans & Billing.",
    retryable: false,
  },
  "provider-auth": {
    title: "Model access is misconfigured",
    detail:
      "The AI provider rejected this deployment's API key. An administrator needs to check the server's API key configuration.",
    retryable: false,
  },
  "provider-rate-limit": {
    title: "The AI provider is throttling requests",
    detail: "Too many requests reached the model provider at once. Wait a few seconds and retry.",
    retryable: true,
    advisory: true,
  },
  "provider-overloaded": {
    title: "The model is busy",
    detail: "The model provider is temporarily overloaded. Retrying usually works.",
    retryable: true,
    advisory: true,
  },
  "context-length": {
    title: "This conversation is too long",
    detail:
      "The request exceeded the model's context window. Reload the page to start a fresh conversation, or ask a shorter question.",
    retryable: false,
  },
  network: {
    title: "Connection interrupted",
    detail:
      "The connection to the server dropped before the answer finished. Check your network and retry.",
    retryable: true,
    advisory: true,
  },
  "session-expired": {
    title: "Session expired",
    detail: "Your sign-in is no longer valid. Reload the page to sign in again.",
    retryable: false,
  },
  unknown: {
    title: "Something went wrong",
    detail:
      "The assistant couldn't complete that request. Retry — if it keeps failing, check the server logs.",
    retryable: true,
  },
};

const TAG_RE = /^\[vc:([a-z-]+)\]\s*/;

function isKind(value: string): value is ChatErrorKind {
  return Object.prototype.hasOwnProperty.call(PRESENTATION, value);
}

interface Extracted {
  text: string;
  status?: number;
}

function tryParseJson(text: string): unknown {
  const t = text.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

/**
 * Flatten an arbitrary error into searchable text plus an HTTP status. Handles
 * Error instances, the plain `{ message, name, statusCode, … }` payloads Mastra
 * puts on its error chunks, JSON-encoded versions of the same (what reaches the
 * client when nothing sanitizes them), and nested `cause` / `error` wrappers.
 * `depth` bounds the walk so a self-referential cause chain can't spin.
 */
function extract(err: unknown, depth = 0): Extracted {
  if (err == null || depth > 3) return { text: "" };
  if (typeof err === "string") {
    const parsed = tryParseJson(err);
    return parsed === undefined ? { text: err } : extract(parsed, depth + 1);
  }
  if (typeof err !== "object") return { text: String(err) };

  const o = err as Record<string, unknown>;
  const parts: string[] = [];
  let status: number | undefined;

  for (const key of ["name", "message", "responseBody", "error", "type"]) {
    const v = o[key];
    if (typeof v === "string") parts.push(v);
  }
  for (const key of ["statusCode", "status"]) {
    const v = o[key];
    if (typeof v === "number") {
      status = v;
      break;
    }
  }
  for (const key of ["cause", "error", "data"]) {
    const v = o[key];
    if (v && typeof v === "object") {
      const nested = extract(v, depth + 1);
      if (nested.text) parts.push(nested.text);
      status ??= nested.status;
    }
  }
  return { text: parts.join(" | "), status };
}

/**
 * Map a raw error of any shape onto a {@link ChatErrorKind}. Order matters:
 * a spent credit balance arrives as a *400* whose only distinguishing feature
 * is the message text, so it has to be tested before the status-code rules.
 */
export function classifyChatError(err: unknown): ChatErrorKind {
  const { text, status } = extract(err);
  const t = text.toLowerCase();

  if (/reached your daily limit/.test(t)) return "daily-limit";
  if (/credit balance|insufficient[_ ]quota|billing|out of credit/.test(t) || status === 402) {
    return "provider-credit";
  }
  if (/prompt is too long|context[_ ]length|maximum context|too many tokens/.test(t)) {
    return "context-length";
  }
  if (
    /invalid[_ ]?api[_ ]?key|authentication[_ ]error|permission[_ ]error|x-api-key|unauthorized/.test(t) ||
    status === 401 ||
    status === 403
  ) {
    // Our own 401 (expired NextAuth session) vs. the provider rejecting our key.
    return /api[_ ]?key|x-api-key|authentication[_ ]error|permission[_ ]error/.test(t)
      ? "provider-auth"
      : "session-expired";
  }
  if (/rate[_ ]limit/.test(t) || status === 429) return "provider-rate-limit";
  if (/overloaded|service unavailable/.test(t) || status === 529 || status === 503) {
    return "provider-overloaded";
  }
  if (/fetch failed|failed to fetch|network|socket|econnre|etimedout|timed? ?out|aborted/.test(t)) {
    return "network";
  }
  return "unknown";
}

/**
 * Server side: the tagged, user-safe one-liner to put on the wire. Never
 * includes provider payloads, URLs, or stack traces — log those separately.
 */
export function toStreamErrorText(err: unknown): string {
  const kind = classifyChatError(err);
  return `[vc:${kind}] ${PRESENTATION[kind].detail}`;
}

/** Tagged text for a kind whose detail is written at the call site (e.g. the
 *  rate-limit message, which names the user's actual limit). */
export function tagged(kind: ChatErrorKind, detail: string): string {
  return `[vc:${kind}] ${detail}`;
}

/**
 * Client side: turn whatever landed in `error.message` into something
 * renderable. Tagged text keeps its server-authored detail verbatim; untagged
 * text is classified and gets the canned detail, with the raw string retained
 * (collapsed in the UI) only when it stayed unclassified.
 */
export function describeChatError(message: string | undefined): ChatErrorInfo {
  const raw = (message ?? "").trim();
  const tag = TAG_RE.exec(raw);

  if (tag && isKind(tag[1])) {
    const kind = tag[1];
    const detail = raw.slice(tag[0].length).trim();
    const p = PRESENTATION[kind];
    return { kind, title: p.title, detail: detail || p.detail, retryable: p.retryable };
  }

  const kind = classifyChatError(raw);
  const p = PRESENTATION[kind];
  return {
    kind,
    title: p.title,
    // The limit message is already a complete, user-facing sentence naming the
    // actual limit — keep it rather than the generic stand-in.
    detail: kind === "daily-limit" && raw ? raw : p.detail,
    retryable: p.retryable,
    ...(kind === "unknown" && raw ? { technical: raw } : {}),
  };
}

/** Whether a kind is an expected, self-resolving condition (warning tone)
 *  rather than a fault (error tone). */
export function isAdvisory(kind: ChatErrorKind): boolean {
  return PRESENTATION[kind].advisory === true;
}
