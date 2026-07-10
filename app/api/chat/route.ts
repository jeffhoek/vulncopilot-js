import { convertToModelMessages, type UIMessage } from "ai";
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
  try {
    const body = (await req.json()) as { messages?: UIMessage[] };
    messages = body.messages ?? [];
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
    // format: 'aisdk' yields an AISDKV5OutputStream whose toUIMessageStreamResponse()
    // emits the SSE UI-message protocol useChat expects (text deltas + tool steps).
    const stream = await agent.stream(convertToModelMessages(messages), {
      format: "aisdk",
    });
    // Authoritative gate + token accounting, run once the stream is fully
    // consumed. `stream.totalUsage` sums every step (analogous to pydantic-ai's
    // result.usage()); it is resolved by the time onFinish fires. This runs
    // server-side after the response has started streaming — fine on a persistent
    // Node server (see `runtime = "nodejs"`); a serverless deploy would need
    // waitUntil to guarantee it completes.
    return stream.toUIMessageStreamResponse({
      onFinish: async () => {
        try {
          const usage = await stream.totalUsage;
          const { allowed, newCount } = await checkAndIncrement(
            pool,
            userId,
            limit,
            usage.inputTokens ?? 0,
            usage.outputTokens ?? 0,
          );
          if (!allowed) {
            // Cannot withhold a streamed answer (see FLAGGED DIVERGENCE above);
            // record + log so the next request is blocked at the pre-check.
            console.warn(
              `Rate limit hit: user=${userId} count=${newCount} limit=${limit}`,
            );
          }
        } catch (err) {
          console.error("Usage accounting failed", err);
        }
      },
    });
  } catch (err) {
    console.error("Chat route error", err);
    return Response.json({ error: "Failed to generate a response." }, { status: 500 });
  }
}
