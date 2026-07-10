import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Phase 1 ships pure-function unit tests (sql-utils). Keep the run fast and
    // node-based; no jsdom or DB needed.
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
