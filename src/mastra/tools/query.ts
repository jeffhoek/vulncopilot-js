import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { isPostgresError, runReadOnlyQuery } from "../../lib/db";
import { applyRowLimit, formatQueryResults, validateSql } from "../../lib/sql-utils";

// Ported from reference `rag/agent.py::query`. validateSql → applyRowLimit →
// execute read-only → formatQueryResults. Returns error strings; never throws
// to the model.
export const queryTool = createTool({
  id: "query",
  description:
    "Execute a read-only SQL SELECT query against the vulnerability database. Use for counts, top-N, date filters, grouping, listing, JOINs, and specific CVE ID lookups.",
  inputSchema: z.object({
    sql: z.string().describe("A single SELECT statement to run against the database."),
  }),
  outputSchema: z.string(),
  execute: async ({ context }) => {
    const error = validateSql(context.sql);
    if (error) {
      return error;
    }

    const sql = applyRowLimit(context.sql);
    // Phase 1 has no tool-step UI yet (Phase 2). Log to dev-server stdout so the
    // DoD's "agent queries BOTH kev and nvd" is observable now.
    console.log("[tool:query]", sql);

    try {
      const result = await runReadOnlyQuery(sql);
      if (result.rows.length === 0) {
        return "No results found.";
      }
      return formatQueryResults(result.rows as Array<Record<string, unknown>>);
    } catch (err) {
      if (isPostgresError(err)) {
        return `Query error: ${err.message}`;
      }
      console.error("Unexpected error in query tool", err);
      return "Internal error executing query.";
    }
  },
});
