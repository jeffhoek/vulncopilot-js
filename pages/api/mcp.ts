import { timingSafeEqual } from "node:crypto";
import type { NextApiRequest, NextApiResponse } from "next";
import { config as env } from "@/src/lib/config";
import { mcpServer } from "@/src/mastra/mcp";

// MCP streamable-HTTP endpoint (Phase 7). Re-exposes the RAG agent's query +
// retrieve tools over MCP. Port of reference `mcp_server/server.py`.
//
// FLAGGED DIVERGENCE (Pages Router, not the plan's app/api/mcp/route.ts): the
// plan named an App Router route, but @mastra/mcp's MCPServer.startHTTP is typed
// against — and internally uses — Node's http.IncomingMessage/ServerResponse
// (req.on('data'), res.writeHead/end), which App Router route handlers do not
// expose (they only see a Web Request and return a Web Response; even the
// library's serverless path calls req.on()/res.end()). A Pages Router API route
// natively provides those Node req/res objects, so MCPServer plugs straight in
// with no adapter and no extra dependency. Same URL (/api/mcp), same tools.
// See IMPLEMENTATION.md Phase 7 for the full rationale.

// The MCP transport reads the raw request stream itself; Next must not consume
// it first.
export const config = {
  api: { bodyParser: false },
};

// Timing-safe API-key comparison (port of reference `secrets.compare_digest`).
// Differing lengths short-circuit — same as compare_digest, which is not
// constant-time across unequal lengths either.
function apiKeyMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Warn once at module load if the endpoint is unauthenticated, mirroring the
// reference middleware's startup warning.
if (!env.MCP_API_KEY) {
  console.warn(
    "MCP_API_KEY is not set — /api/mcp is UNAUTHENTICATED. Set MCP_API_KEY before deploying.",
  );
}

export default async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  // Auth: when a key is configured, require a matching x-api-key header. When it
  // is unset the endpoint is open (warned above), matching the reference.
  if (env.MCP_API_KEY) {
    const header = req.headers["x-api-key"];
    const provided = Array.isArray(header) ? (header[0] ?? "") : (header ?? "");
    if (!apiKeyMatches(provided, env.MCP_API_KEY)) {
      res.status(401).json({ detail: "Unauthorized" });
      return;
    }
  }

  // NextApiRequest/Response extend Node's http.IncomingMessage/ServerResponse,
  // which is exactly what startHTTP expects. httpPath must equal the request
  // pathname or startHTTP 404s.
  const url = new URL(req.url ?? "/api/mcp", "http://localhost");
  await mcpServer.startHTTP({
    url,
    httpPath: "/api/mcp",
    req,
    res,
  });
}
