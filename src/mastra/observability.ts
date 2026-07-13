import { Observability } from "@mastra/observability";
import { LangfuseExporter } from "@mastra/langfuse";

// Langfuse tracing is opt-in: enabled only when BOTH keys are present. Takes
// values as arguments (never imports `config`) so it stays unit-testable
// without a filled `.env` — same convention as sql-utils.
export interface LangfuseSettings {
  publicKey?: string;
  secretKey?: string;
  baseUrl: string;
  // Dev flushes each event immediately (traces visible in the Langfuse UI
  // within seconds); production uses the exporter's default batching. Batched
  // events still in memory can be lost on shutdown — acceptable for tracing;
  // tune flushAt/flushInterval on the exporter if that ever matters.
  dev: boolean;
}

// Returns undefined when Langfuse is not (fully) configured, so the Mastra
// constructor gets no `observability` key and the app runs exactly as before.
export function buildObservability(s: LangfuseSettings): Observability | undefined {
  if (!s.publicKey || !s.secretKey) {
    if (s.publicKey || s.secretKey) {
      // Misconfiguration (one key without the other) must not break boot.
      console.warn(
        "[observability] Only one of LANGFUSE_PUBLIC_KEY/LANGFUSE_SECRET_KEY is set; Langfuse tracing disabled.",
      );
    }
    return undefined;
  }
  return new Observability({
    configs: {
      langfuse: {
        serviceName: "vulncopilot",
        exporters: [
          new LangfuseExporter({
            publicKey: s.publicKey,
            secretKey: s.secretKey,
            baseUrl: s.baseUrl,
            realtime: s.dev,
            environment: s.dev ? "development" : "production",
          }),
        ],
      },
    },
  });
}
