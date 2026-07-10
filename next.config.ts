import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Mastra + pg are server-only; keep them out of the client bundle and
  // don't let Next try to bundle native/optional deps.
  serverExternalPackages: ["@mastra/core", "pg"],
};

export default nextConfig;
