import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessage,
} from "ai";
import { toAISdkStream } from "@mastra/ai-sdk";
import { mastra } from "@/src/mastra";
import { auth } from "@/auth";
import { config } from "@/src/lib/config";
import { pool } from "@/src/lib/db";
import {
  checkAndIncrement,
  currentDailyCount,
  limitFor,
  limitMessage,
} from "@/src/lib/usage";

// pg + Mastra are Node-only; force the Node runtime (not Edge).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RATE_LIMIT_CONFIG = {
  dailyQueryLimit: config.DAILY_QUERY_LIMIT,
  adminDailyQueryLimit: config.ADMIN_DAILY_QUERY_LIMIT,
  adminUserIdentifiers: config.ADMIN_USER_IDENTIFIERS,
};

// Phase 2: streaming. Accepts { messages } as AI SDK v5 UIMessages (already
// trimmed to MAX_HISTORY_MESSAGES by the client — see app/chat.tsx), converts
// them to model messages, and streams the agent's response back as a UI message
// stream that `useChat` consumes.
//
// Phase 4: per-user daily rate limiting (reference `app.py` enforce/record flow).
// A cheap read-only pre-check blocks an already-over-limit user before any LLM
// work; the authoritative atomic upsert runs after the run finishes, recording
// token usage and blocking subsequent requests once the count crosses the limit.
//
// FLAGGED DIVERGENCE (streaming vs. the reference's "withhold the answer"): the
// reference is non-streaming, so it can atomically count and then decline to send
// the answer on the rare TOCTOU race (two concurrent requests both pass the
// pre-check). We stream tokens as they are generated, so by the time the run
// finishes and usage is known the answer has already reached the client — it
// cannot be withheld. The pre-check still fully bounds a sequential user, and the
// post-run upsert still records the over-count and blocks the next request, so at
// most a small concurrent burst slips through. See IMPLEMENTATION.md Phase 4.
export async function POST(req: Request): Promise<Response> {
  // Auth gate (Phase 3): no valid session → 401 before any LLM work.
  const session = await auth();
  if (!session?.userId) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }
  const userId = session.userId;
  const limit = limitFor(userId, RATE_LIMIT_CONFIG);

  let messages: UIMessage[];
  let chatId: string | undefined;
  try {
    const body = (await req.json()) as { messages?: UIMessage[]; chatId?: string };
    messages = body.messages ?? [];
    // Client-generated conversation id (see app/chat.tsx), forwarded to
    // Langfuse as session.id. Client-controlled, so validate and cap it.
    chatId =
      typeof body.chatId === "string" && body.chatId.length > 0 && body.chatId.length <= 64
        ? body.chatId
        : undefined;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    return Response.json({ error: "`messages` must be a non-empty array." }, { status: 400 });
  }

  // Cheap best-effort pre-check: block an already-over-limit user before the LLM
  // call (reference `enforce_daily_limit`, `count >= limit`). The transport
  // surfaces a non-ok response body as `error.message`, so the plain-text limit
  // message renders verbatim in the UI. 429 = Too Many Requests.
  try {
    if ((await currentDailyCount(pool, userId)) >= limit) {
      console.warn(`[rate-limit] pre-check blocked user=${userId} limit=${limit}`);
      return new Response(limitMessage(limit), {
        status: 429,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
  } catch (err) {
    // A pre-check DB hiccup must not hard-fail the request; the authoritative
    // upsert below is the real gate. Log and proceed.
    console.error("Rate-limit pre-check failed", err);
  }

  try {
    const agent = mastra.getAgent("ragAgent");
    // Authoritative gate + token accounting. Runs in Mastra's stream onFinish,
    // fired in-band as the stream is consumed — the event carries the run's
    // `totalUsage` (all steps summed) directly, so there is no promise to await
    // on a teed branch (the pre-v1 hang pitfall) and no manual step summing
    // (analogous to pydantic-ai's result.usage()). Server-side post-stream work
    // like this is fine on a persistent Node server (see `runtime = "nodejs"`);
    // a serverless deploy would need waitUntil to guarantee it completes.
    const stream = await agent.stream(convertToModelMessages(messages), {
      // Trace attribution (inert unless Langfuse is configured — see
      // src/mastra/observability.ts). The Langfuse exporter maps
      // metadata.userId → user.id and metadata.sessionId → session.id.
      tracingOptions: {
        metadata: {
          userId,
          ...(chatId ? { sessionId: chatId } : {}),
        },
      },
      onFinish: async (event) => {
        try {
          const inputTokens = event.totalUsage.inputTokens ?? 0;
          const outputTokens = event.totalUsage.outputTokens ?? 0;
          const { allowed, newCount } = await checkAndIncrement(
            pool,
            userId,
            limit,
            inputTokens,
            outputTokens,
          );
          console.log(
            `[rate-limit] recorded user=${userId} count=${newCount} limit=${limit} in=${inputTokens} out=${outputTokens} allowed=${allowed}`,
          );
          if (!allowed) {
            // Cannot withhold a streamed answer (see FLAGGED DIVERGENCE above);
            // record + log so the next request is blocked at the pre-check.
            console.warn(`Rate limit hit: user=${userId} count=${newCount} limit=${limit}`);
          }
        } catch (err) {
          console.error("Usage accounting failed", err);
        }
      },
    });

    // v1 removed `format: 'aisdk'`; toAISdkStream (@mastra/ai-sdk) converts the
    // Mastra stream into the AI SDK UI-message chunk stream (text deltas + tool
    // steps), which createUIMessageStreamResponse serves as the SSE protocol
    // useChat expects. `originalMessages` prevents duplicated assistant messages.
    const uiMessageStream = createUIMessageStream({
      originalMessages: messages,
      execute: ({ writer }) => {
        writer.merge(toAISdkStream(stream, { from: "agent" }));
      },
    });
    return createUIMessageStreamResponse({ stream: uiMessageStream });
  } catch (err) {
    console.error("Chat route error", err);
    return Response.json({ error: "Failed to generate a response." }, { status: 500 });
  }
}
