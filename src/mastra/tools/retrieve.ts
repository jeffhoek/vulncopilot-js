import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { config } from "../../lib/config";
import { pool } from "../../lib/db";
import { generateEmbedding } from "../embeddings";

// Ported from reference `rag/vector_store.py::search` + `rag/agent.py::retrieve`.
// Embeds the query, then runs the hand-written cross-table UNION ALL cosine
// search over both vuln tables. The embedding is passed as a '[f1,f2,…]' string
// with an explicit ::vector cast (node-postgres has no pgvector codec, unlike
// asyncpg). Never re-embeds the corpus — the vectors already exist in the DB.
export const retrieveTool = createTool({
  id: "retrieve",
  description:
    "Retrieve relevant context from the knowledge base via semantic search across both the KEV and NVD datasets. Use for conceptual questions.",
  inputSchema: z.object({
    query: z.string().describe("The search query to find relevant documents."),
  }),
  // No outputSchema — see the note in query.ts: MCP requires an object output
  // schema, so a scalar z.string() breaks the MCP tools/call result. The tool
  // returns a plain string, surfaced as MCP text content (reference parity).
  execute: async ({ context }) => {
    // Phase 1 has no tool-step UI yet (Phase 2); log to dev-server stdout.
    console.log("[tool:retrieve]", context.query);
    const embedding = await generateEmbedding(context.query);
    const vectorLiteral = `[${embedding.join(",")}]`;

    const result = await pool.query<{ content: string }>(
      `SELECT content FROM (
         SELECT content, embedding <=> $1::vector AS distance
         FROM kev_vulnerabilities
         UNION ALL
         SELECT content, embedding <=> $1::vector AS distance
         FROM nvd_vulnerabilities
       ) combined
       ORDER BY distance
       LIMIT $2`,
      [vectorLiteral, config.TOP_K],
    );

    if (result.rows.length === 0) {
      return "No relevant context found.";
    }
    const contexts = result.rows.map((r) => r.content);
    return `Retrieved context:\n\n${contexts.join("\n\n---\n\n")}`;
  },
});
