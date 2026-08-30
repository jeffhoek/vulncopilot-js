import { Mastra } from "@mastra/core";
import { ragAgent } from "./agents/rag-agent";
import { config } from "../lib/config";
import { buildObservability } from "./observability";

// Single Mastra instance, embedded in the Next.js app (no standalone server).
// Cached on globalThis so Next dev hot-reload reuses it — which also means
// changing LANGFUSE_* / LOGFIRE_* env vars requires a dev-server restart to
// take effect.
const globalForMastra = globalThis as unknown as {
  __mastraInstance?: ReturnType<typeof createMastra>;
};

// Tracing (Langfuse and/or Logfire) is enabled only when the matching env vars
// are configured; with none set, `observability` is undefined and the
// constructor is identical to the untraced setup.
function createMastra() {
  const { observability, flush } = buildObservability({
    langfuse: {
      publicKey: config.LANGFUSE_PUBLIC_KEY,
      secretKey: config.LANGFUSE_SECRET_KEY,
      baseUrl: config.LANGFUSE_BASE_URL,
    },
    logfire: {
      token: config.LOGFIRE_TOKEN,
      baseUrl: config.LOGFIRE_BASE_URL,
    },
    dev: process.env.NODE_ENV !== "production",
  });
  return {
    mastra: new Mastra({
      agents: { ragAgent },
      ...(observability ? { observability } : {}),
    }),
    flushObservability: flush,
  };
}

// Instance and its flush are cached together: on hot reload a bare rebuild
// would hand back a flush closing over a fresh exporter that was never
// registered with the cached Mastra, so flushing it would silently do nothing.
const instance = (globalForMastra.__mastraInstance ??= createMastra());

export const mastra: Mastra = instance.mastra;

// Force-flush pending spans. Called by the chat route once a response stream
// has ended — see the note in src/mastra/observability.ts on why the Logfire
// path needs it and Langfuse does not.
export const flushObservability = instance.flushObservability;
