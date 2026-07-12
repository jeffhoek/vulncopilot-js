import { Mastra } from "@mastra/core";
import { LangfuseExporter } from "@mastra/langfuse";
import { config } from "../lib/config";
import { ragAgent } from "./agents/rag-agent";

// Single Mastra instance, embedded in the Next.js app (no standalone server).
// Cached on globalThis so Next dev hot-reload reuses it.
const globalForMastra = globalThis as unknown as {
  __mastra?: Mastra;
  // A flush closure over the Langfuse client, cached alongside the instance so it
  // survives dev hot-reloads (which reuse __mastra without calling buildMastra).
  __langfuseFlush?: () => Promise<void>;
};

// The exporter's `client` field is typed private but is a plain runtime property;
// reach it through this shape to force a flush. Prefer
// awaitAllQueuedAndPendingRequests(): unlike flushAsync(), it also awaits the
// in-flight ingestion promises — i.e. the floating fetches that realtime mode
// already spliced out of the queue — so nothing is left mid-send. flushAsync is a
// fallback. Optional-chained everywhere so a version change can't crash boot.
type LangfuseClientLike = {
  awaitAllQueuedAndPendingRequests?: () => Promise<void>;
  flushAsync?: () => Promise<void>;
};

// Mastra AI tracing (new `observability` API, NOT the deprecated `telemetry`
// OTel path below). Enabled ONLY when both Langfuse keys are present, so local
// dev/tests/CI run trace-free with no code change. When enabled, agent runs and
// their tool calls (query/retrieve) plus token usage are exported to Langfuse.
// See docs/observability-langfuse.md. Per-request user attribution is attached
// in the chat route via tracingOptions.metadata.userId.
//
// Built INSIDE the cache-miss branch below so the LangfuseExporter (which opens a
// Langfuse client with a flush timer + process exit listener) is constructed once
// per process, not on every Next.js dev hot-reload module re-evaluation.
function buildObservability() {
  if (!config.LANGFUSE_PUBLIC_KEY || !config.LANGFUSE_SECRET_KEY) {
    console.log("[observability] Langfuse tracing DISABLED (keys not set)");
    return undefined;
  }
  // Boot-time confirmation of the LIVE tracing config. Prints once per process on
  // a cold start — if you don't see this line (with the expected host/realtime)
  // after starting the app, you are running a stale process (env is read only at
  // startup; the Mastra instance is cached on globalThis across hot-reloads).
  console.log(
    `[observability] Langfuse tracing ENABLED host=${config.LANGFUSE_BASE_URL} ` +
      `realtime=${config.LANGFUSE_REALTIME} debug=${config.LANGFUSE_DEBUG}`,
  );
  const exporter = new LangfuseExporter({
    publicKey: config.LANGFUSE_PUBLIC_KEY,
    secretKey: config.LANGFUSE_SECRET_KEY,
    baseUrl: config.LANGFUSE_BASE_URL,
    // realtime flushes per event, but Mastra exports spans fire-and-forget, so the
    // actual HTTP send is a floating promise the runtime may not drive to
    // completion after the response (deferred for minutes in dev; dropped on Cloud
    // Run scale-to-zero). The deterministic guarantee is the after()-driven
    // flushTracing() in the chat route — realtime just narrows the window.
    realtime: config.LANGFUSE_REALTIME,
    // Exporter diagnostic logging (LANGFUSE_DEBUG). At the default 'warn' the
    // exporter still logs its trace-map problems ("No trace data found for span" /
    // "No Langfuse span found") — the signature to watch if spans silently stop
    // appearing. 'debug' adds per-trace-creation logs.
    logLevel: config.LANGFUSE_DEBUG ? "debug" : "warn",
    options: { environment: process.env.NODE_ENV },
  });
  const client = (exporter as unknown as { client?: LangfuseClientLike }).client;
  const flush = client?.awaitAllQueuedAndPendingRequests
    ? () => client.awaitAllQueuedAndPendingRequests!()
    : client?.flushAsync
      ? () => client.flushAsync!()
      : undefined;
  // If this logs flush=NONE, the private-client reach-through broke (version
  // change) and after() can't force delivery — traces will lag. See runbook.
  console.log(
    `[observability] flush handle=${flush ? "captured" : "NONE"}`,
  );
  return {
    observability: {
      configs: { langfuse: { serviceName: "vulncopilot", exporters: [exporter] } },
    },
    flush,
  };
}

function buildMastra(): Mastra {
  const built = buildObservability();
  globalForMastra.__langfuseFlush = built?.flush;
  return new Mastra({
    agents: { ragAgent },
    // Disable the deprecated OTel telemetry (avoids the "instrumentation file
    // was not loaded" warning when Mastra runs embedded in Next.js). Tracing is
    // handled by the modern `observability` config above instead.
    telemetry: { enabled: false },
    ...(built ? { observability: built.observability } : {}),
  });
}

export const mastra: Mastra = globalForMastra.__mastra ?? buildMastra();

if (!globalForMastra.__mastra) {
  globalForMastra.__mastra = mastra;
}

/**
 * Deterministically flush buffered Langfuse spans and await the network send.
 * Call from the chat route via Next's `after()` so tracing delivery does not
 * depend on the runtime driving Mastra's fire-and-forget exports to completion.
 * No-op when tracing is disabled.
 */
export async function flushTracing(): Promise<void> {
  try {
    await globalForMastra.__langfuseFlush?.();
  } catch (err) {
    console.error("[observability] Langfuse flush failed", err);
  }
}
