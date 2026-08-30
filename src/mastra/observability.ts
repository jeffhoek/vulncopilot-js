import { Observability } from "@mastra/observability";
import type { ObservabilityExporter } from "@mastra/core/observability";
import { LangfuseExporter } from "@mastra/langfuse";
// Pinned exactly to 1.3.10 in package.json, and it cannot be bumped on its
// own: 1.3.11+ import `resolveExportedSpanId` from @mastra/core/observability,
// which @mastra/core 1.59.0 does not export. The failure is a module-resolution
// SyntaxError at import time — it takes the whole app down, not just tracing —
// so raise the core version first, then this one.
import { OtelExporter } from "@mastra/otel-exporter";
// Imported STATICALLY and handed to OtelExporter below, rather than letting it
// resolve this itself. Left to its own devices it does `await import(pkg)` off
// a protocol lookup table; Next's file tracing cannot follow a computed
// specifier, and even with the files force-copied into the bundle the bare
// specifier does not resolve, because pnpm's isolated layout links packages
// through `.pnpm/node_modules` and nothing creates that link for a dependency
// no traced module names. In the container the import throws
// ERR_MODULE_NOT_FOUND, OtelExporter catches it and logs "not installed", and
// tracing is silently off while the app serves normally. A static import here
// is traced like any other dependency and resolves from the app root.
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";

// Tracing is opt-in per backend: Langfuse needs BOTH keys, Logfire needs its
// write token. Either, both, or neither may be configured — both exporters go
// into ONE Observability config, so a trace fans out to every backend that is
// switched on rather than the registry having to pick between them.
//
// Takes values as arguments (never imports `config`) so it stays unit-testable
// without a filled `.env` — same convention as sql-utils.
export interface ObservabilitySettings {
  langfuse: {
    publicKey?: string;
    secretKey?: string;
    baseUrl: string;
  };
  logfire: {
    // Logfire write token. Unlike the reference repo there is no separate
    // LOGFIRE_ENABLED flag — see the note in config.ts.
    token?: string;
    // Region base URL, WITHOUT a signal path: OtelExporter appends /v1/traces.
    baseUrl: string;
  };
  // Distinguishes the Langfuse `environment` label only.
  dev: boolean;
}

export interface BuiltObservability {
  // undefined when nothing is configured, so the Mastra constructor gets no
  // `observability` key and the app runs exactly as before.
  observability?: Observability;
  // Force-flush buffered spans. Langfuse in realtime mode has nothing to
  // flush, but the Logfire path cannot do realtime: OtelExporter always wraps
  // its OTLP exporter in a BatchSpanProcessor on a 5s timer, which is exactly
  // the timer a frozen Cloud Run instance never reaches. The chat route calls
  // this once the response stream ends (see app/api/chat/route.ts).
  flush: () => Promise<void>;
}

const NOOP_FLUSH = async () => {};

function buildLangfuseExporter(
  s: ObservabilitySettings,
): ObservabilityExporter | undefined {
  const { publicKey, secretKey, baseUrl } = s.langfuse;
  if (!publicKey || !secretKey) {
    if (publicKey || secretKey) {
      // Misconfiguration (one key without the other) must not break boot.
      console.warn(
        "[observability] Only one of LANGFUSE_PUBLIC_KEY/LANGFUSE_SECRET_KEY is set; Langfuse tracing disabled.",
      );
    }
    return undefined;
  }
  return new LangfuseExporter({
    publicKey,
    secretKey,
    baseUrl,
    // Flush inline in every environment. On scale-to-zero Cloud Run, CPU is
    // throttled between requests and the instance freezes before a background
    // batch timer fires, so batched events never ship. Inline flush trades a
    // little per-event latency for traces that actually arrive. The Logfire
    // exporter has no equivalent option, which is why BuiltObservability.flush
    // exists.
    realtime: true,
    environment: s.dev ? "development" : "production",
  });
}

function buildLogfireExporter(
  s: ObservabilitySettings,
): ObservabilityExporter | undefined {
  const { token, baseUrl } = s.logfire;
  if (!token) return undefined;
  // Logfire's write token IS the Authorization value — no "Bearer" prefix.
  const headers = { Authorization: token };
  return new OtelExporter({
    // Logfire ingests plain OTLP, so it needs no dedicated Mastra package —
    // the generic `custom` provider is the whole integration. Spans arrive as
    // GenAI v1.38 semconv, which is what makes Logfire render agent runs, tool
    // calls and token counts natively.
    //
    // `provider` is still required even though `exporter` below supersedes it
    // for traces: OtelExporter disables itself outright if no provider is
    // configured. Keep the two in agreement.
    provider: {
      custom: {
        endpoint: baseUrl,
        headers,
        // `custom` would otherwise default to http/json, which Logfire's OTLP
        // endpoint does not accept.
        protocol: "http/protobuf",
      },
    },
    // Pre-built rather than resolved by OtelExporter — see the import note.
    // The signal path is ours to append here; the provider form appends it.
    exporter: new OTLPTraceExporter({ url: `${baseUrl}/v1/traces`, headers }),
    // Traces only. Log export would need @opentelemetry/exporter-logs-otlp-proto
    // as well; the reference repo only instruments traces (pydantic-ai +
    // openai), so shipping Mastra's internal logs would be new volume, not
    // parity. Flip to `true` and add that package to enable it.
    signals: { traces: true, logs: false },
  });
}

export function buildObservability(s: ObservabilitySettings): BuiltObservability {
  const exporters = [buildLangfuseExporter(s), buildLogfireExporter(s)].filter(
    (e): e is ObservabilityExporter => e !== undefined,
  );
  if (exporters.length === 0) return { flush: NOOP_FLUSH };

  const observability = new Observability({
    // Name is deliberately not "default": Mastra registers its own built-in
    // instance under that name when `default.enabled` is set, so reusing it
    // would silently shadow one or the other.
    configs: {
      tracing: {
        serviceName: "vulncopilot",
        exporters,
      },
    },
  });
  // Observability.flush() drains the event bus and then calls flush() on every
  // registered exporter, so this covers whichever backends are enabled.
  return { observability, flush: () => observability.flush() };
}
