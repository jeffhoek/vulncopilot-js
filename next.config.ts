import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained server bundle (`.next/standalone`) for a small production
  // Docker image — copies only the traced runtime deps, no full node_modules.
  output: "standalone",
  // Mastra + pg are server-only; keep them out of the client bundle and
  // don't let Next try to bundle native/optional deps.
  serverExternalPackages: [
    "@mastra/core",
    "@mastra/observability",
    "@mastra/langfuse",
    // Logfire path: the OTLP exporter and its @opentelemetry/* deps are
    // server-only and load their protobuf exporter via a runtime dynamic
    // import, which the bundler cannot follow.
    "@mastra/otel-exporter",
    "@opentelemetry/exporter-trace-otlp-proto",
    "pg",
  ],
  // Next 16's require-hook aliases a handful of modules to
  // `@swc/helpers/esm/*` at *runtime*, so file tracing never sees those paths
  // and traces only the two `cjs/` helpers it can statically find. The
  // standalone server then dies on its first require with
  // "Cannot find module .../@swc/helpers/esm/_interop_require_default.js".
  // `next build` is unaffected — this only shows up when the built server runs,
  // which is why CI boots it (see .github/workflows/ci.yml).
  outputFileTracingIncludes: {
    "/**/*": [
      "./node_modules/.pnpm/@swc+helpers@*/node_modules/@swc/helpers/**",
      // Same shape of problem, different cause: @mastra/otel-exporter picks its
      // OTLP exporter package at *runtime* (`await import(spec.pkg)` off a
      // protocol lookup table), so file tracing never sees this specifier and
      // the standalone bundle ships without it. The failure is quiet — the
      // exporter logs "not available for protocol" and disables itself, so
      // Logfire tracing just goes dark in production while the app runs fine.
      // Its three deps (otlp-exporter-base, otlp-transformer, sdk-trace) are
      // already traced via other packages at matching versions.
      "./node_modules/.pnpm/@opentelemetry+exporter-trace-otlp-proto@*/node_modules/@opentelemetry/exporter-trace-otlp-proto/**",
    ],
  },
};

export default nextConfig;
