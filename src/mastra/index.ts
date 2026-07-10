import { Mastra } from "@mastra/core";
import { ragAgent } from "./agents/rag-agent";

// Single Mastra instance, embedded in the Next.js app (no standalone server).
// Cached on globalThis so Next dev hot-reload reuses it.
const globalForMastra = globalThis as unknown as { __mastra?: Mastra };

export const mastra: Mastra =
  globalForMastra.__mastra ??
  new Mastra({
    agents: { ragAgent },
    // Disable the deprecated OTel telemetry (avoids the "instrumentation file
    // was not loaded" warning when Mastra runs embedded in Next.js).
    telemetry: { enabled: false },
  });

if (!globalForMastra.__mastra) {
  globalForMastra.__mastra = mastra;
}
