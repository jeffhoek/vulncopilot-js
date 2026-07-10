import { convertToModelMessages, type UIMessage } from "ai";
import { mastra } from "@/src/mastra";

// pg + Mastra are Node-only; force the Node runtime (not Edge).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Phase 2: streaming. Accepts { messages } as AI SDK v5 UIMessages (already
// trimmed to MAX_HISTORY_MESSAGES by the client — see app/chat.tsx), converts
// them to model messages, and streams the agent's response back as a UI message
// stream that `useChat` consumes. Auth and rate limiting still come later.
export async function POST(req: Request): Promise<Response> {
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

  try {
    const agent = mastra.getAgent("ragAgent");
    // format: 'aisdk' yields an AISDKV5OutputStream whose toUIMessageStreamResponse()
    // emits the SSE UI-message protocol useChat expects (text deltas + tool steps).
    const stream = await agent.stream(convertToModelMessages(messages), {
      format: "aisdk",
    });
    return stream.toUIMessageStreamResponse();
  } catch (err) {
    console.error("Chat route error", err);
    return Response.json({ error: "Failed to generate a response." }, { status: 500 });
  }
}
