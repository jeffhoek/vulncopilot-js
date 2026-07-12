import { MCPServer } from "@mastra/mcp";
import { queryTool } from "./tools/query";
import { retrieveTool } from "./tools/retrieve";

// MCP server exposing the SAME query + retrieve tool implementations the RAG
// agent uses (reuse, not duplicate — see CLAUDE.md / PORTING.md §MCP). Port of
// reference `mcp_server/server.py`, which registered `retrieve` and `query`
// FastMCP tools backed by the same sql_utils / vector_store code.
//
// Cached on globalThis so Next dev hot-reload does not construct a new server
// (and duplicate transports) on every module reload — same pattern as the
// Mastra instance and the pg Pool.
const globalForMcp = globalThis as unknown as { __mcpServer?: MCPServer };

export const mcpServer: MCPServer =
  globalForMcp.__mcpServer ??
  new MCPServer({
    id: "kev-nvd-rag",
    name: "kev-nvd-rag",
    version: "1.0.0",
    tools: { query: queryTool, retrieve: retrieveTool },
  });

if (!globalForMcp.__mcpServer) {
  globalForMcp.__mcpServer = mcpServer;
}
