import type { ModelMessage } from "ai";
import { mastra } from "@/src/mastra";

// pg + Mastra are Node-only; force the Node runtime (not Edge).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Phase 1: non-streaming. Accepts { messages }, runs the RAG agent, returns the
// final text. Streaming, history trimming, auth, and rate limiting come later.
export async function POST(req: Request): Promise<Response> {
  let messages: ModelMessage[];
  try {
    const body = (await req.json()) as { messages?: ModelMessage[] };
    messages = body.messages ?? [];
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    return Response.json({ error: "`messages` must be a non-empty array." }, { status: 400 });
  }

  try {
    const agent = mastra.getAgent("ragAgent");
    const result = await agent.generate(messages);
    return Response.json({ text: result.text });
  } catch (err) {
    console.error("Chat route error", err);
    return Response.json({ error: "Failed to generate a response." }, { status: 500 });
  }
}
