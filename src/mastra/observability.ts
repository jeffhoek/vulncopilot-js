import { Observability } from "@mastra/observability";
import { LangfuseExporter } from "@mastra/langfuse";

// Langfuse tracing is opt-in: enabled only when BOTH keys are present. Takes
// values as arguments (never imports `config`) so it stays unit-testable
// without a filled `.env` — same convention as sql-utils.
export interface LangfuseSettings {
  publicKey?: string;
  secretKey?: string;
  baseUrl: string;
  // Flush inline (realtime) in every environment. On scale-to-zero Cloud Run,
  // CPU is throttled between requests and the instance freezes before the
  // exporter's background batch timer fires, so batched events never ship.
  // Inline flush trades a little per-event latency for traces that actually
  // arrive. `dev` still distinguishes the Langfuse `environment` label below.
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
            realtime: true,
            environment: s.dev ? "development" : "production",
          }),
        ],
      },
    },
  });
}
