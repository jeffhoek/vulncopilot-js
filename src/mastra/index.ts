import { Mastra } from "@mastra/core";
import { ragAgent } from "./agents/rag-agent";
import { config } from "../lib/config";
import { buildObservability } from "./observability";

// Single Mastra instance, embedded in the Next.js app (no standalone server).
// Cached on globalThis so Next dev hot-reload reuses it — which also means
// changing LANGFUSE_* env vars requires a dev-server restart to take effect.
const globalForMastra = globalThis as unknown as { __mastra?: Mastra };

// Langfuse tracing, enabled only when both keys are configured (undefined
// otherwise, leaving the constructor identical to the untraced setup).
const observability = buildObservability({
  publicKey: config.LANGFUSE_PUBLIC_KEY,
  secretKey: config.LANGFUSE_SECRET_KEY,
  baseUrl: config.LANGFUSE_BASE_URL,
  dev: process.env.NODE_ENV !== "production",
});

export const mastra: Mastra =
  globalForMastra.__mastra ??
  new Mastra({
    agents: { ragAgent },
    ...(observability ? { observability } : {}),
  });

if (!globalForMastra.__mastra) {
  globalForMastra.__mastra = mastra;
}
