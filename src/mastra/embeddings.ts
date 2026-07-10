import { openai } from "@ai-sdk/openai";
import { embed } from "ai";
import { config } from "../lib/config";

// Ported from reference `rag/embeddings.py`. Uses the AI SDK's embed() with the
// pinned OpenAI embedding model (text-embedding-3-small, 1536-d). Must match the
// vectors already stored by the Python ETL side — do NOT change the model.
export async function generateEmbedding(text: string): Promise<number[]> {
  const { embedding } = await embed({
    model: openai.embedding(config.EMBEDDING_MODEL),
    value: text,
  });
  return embedding;
}
