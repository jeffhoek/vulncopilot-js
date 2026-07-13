import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained server bundle (`.next/standalone`) for a small production
  // Docker image — copies only the traced runtime deps, no full node_modules.
  output: "standalone",
  // Mastra + pg are server-only; keep them out of the client bundle and
  // don't let Next try to bundle native/optional deps.
  serverExternalPackages: ["@mastra/core", "@mastra/observability", "@mastra/langfuse", "pg"],
};

export default nextConfig;
