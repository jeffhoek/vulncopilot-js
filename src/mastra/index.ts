import { Mastra } from "@mastra/core";
import { ragAgent } from "./agents/rag-agent";

// Single Mastra instance, embedded in the Next.js app (no standalone server).
// Cached on globalThis so Next dev hot-reload reuses it.
const globalForMastra = globalThis as unknown as { __mastra?: Mastra };

export const mastra: Mastra =
  globalForMastra.__mastra ??
  new Mastra({
    agents: { ragAgent },
    // v1 dropped the deprecated OTel `telemetry` option; observability is now
    // opt-in via @mastra/observability, so nothing to disable here.
  });

if (!globalForMastra.__mastra) {
  globalForMastra.__mastra = mastra;
}
