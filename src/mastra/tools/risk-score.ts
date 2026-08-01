import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { isPostgresError, pool } from "../../lib/db";
import { MAX_BATCH, scoreCves } from "../../lib/risk";

// Ported from reference `rag/agent.py::risk_score` + `mcp_server/server.py::risk_score`,
// both of which are thin wrappers over `rag/risk.py::score_cves` — same reuse here.
//
// This tool does NOT go through validateSql/applyRowLimit: it builds its own
// parameterized SELECT against v_cve_risk (see risk.ts), so there is no
// LLM-authored SQL to validate. The bound $1 array is the only thing between a
// tool argument and the database, and the batch cap bounds the result size that
// applyRowLimit would otherwise bound.
export const riskScoreTool = createTool({
  id: "risk_score",
  description:
    "Composite 0-100 risk score for specific CVEs, with a per-signal breakdown. Blends CVSS severity, EPSS likelihood, KEV listing, SSVC urgency, and CWE weakness class into one number. Use this for a handful of NAMED CVEs. For ranking, filtering, or counting across the corpus, query the `v_cve_risk` view with the `query` tool instead — one ORDER BY beats 25 tool calls. The score is a blend, not a fifth signal: when the question is specifically about likelihood or severity, cite epss_probability or cvss_score directly. Bands are relative to this corpus: 0-24 low, 25-44 moderate, 45-64 high, 65-100 critical (critical effectively requires KEV listing).",
  inputSchema: z.object({
    cve_ids: z
      .array(z.string())
      .describe(
        `CVE IDs to score, e.g. ["CVE-2021-44228"]. At most ${MAX_BATCH} per call; they are ranked highest-risk first in the result.`,
      ),
  }),
  // No outputSchema, and a JSON string rather than an array — same constraint as
  // query.ts/retrieve.ts: MCP requires a tool's outputSchema to be an OBJECT
  // type, and an array is no more a record than a scalar string is. The
  // reference returns `list[RiskScore] | str`, which pydantic-ai serializes to
  // JSON for the model anyway, so the model sees equivalent content either way
  // while MCP still gets valid text content.
  execute: async (inputData) => {
    console.log("[tool:risk_score]", inputData.cve_ids.join(", "));

    try {
      const result = await scoreCves(pool, inputData.cve_ids);
      // Validation failures come back as a string, already model-readable.
      return typeof result === "string" ? result : JSON.stringify(result);
    } catch (err) {
      if (isPostgresError(err)) {
        // The most likely production failure is the view missing or SELECT not
        // granted to app_readonly, so name it rather than only echoing SQLSTATE.
        return `Risk score error: ${err.message}`;
      }
      console.error("Unexpected error in risk_score tool", err);
      return "Internal error computing risk scores.";
    }
  },
});
