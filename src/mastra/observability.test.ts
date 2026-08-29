import { afterEach, describe, expect, it, vi } from "vitest";
import { buildObservability, type ObservabilitySettings } from "./observability";

// Neither backend configured — individual tests switch on the one they cover.
const BASE: ObservabilitySettings = {
  langfuse: { baseUrl: "https://cloud.langfuse.com" },
  logfire: { baseUrl: "https://logfire-us.pydantic.dev" },
  dev: true,
};

const withLangfuse = (over: Partial<ObservabilitySettings["langfuse"]> = {}) => ({
  ...BASE,
  langfuse: { ...BASE.langfuse, publicKey: "pk-lf-x", secretKey: "sk-lf-x", ...over },
});

describe("buildObservability", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns no instance when nothing is configured", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(buildObservability(BASE).observability).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("still returns a usable no-op flush when nothing is configured", async () => {
    // The chat route calls flush() unconditionally, so it must never be
    // undefined just because tracing is off.
    await expect(buildObservability(BASE).flush()).resolves.toBeUndefined();
  });

  it("returns no instance and warns when only the Langfuse public key is set", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const built = buildObservability(withLangfuse({ secretKey: undefined }));
    expect(built.observability).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("returns no instance and warns when only the Langfuse secret key is set", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const built = buildObservability(withLangfuse({ publicKey: undefined }));
    expect(built.observability).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("returns an Observability instance when both Langfuse keys are set", () => {
    expect(buildObservability(withLangfuse()).observability).toBeDefined();
  });

  it("returns an Observability instance when only the Logfire token is set", () => {
    // Logfire is independent of Langfuse: a token on its own must enable
    // tracing, and must not trip the Langfuse half-configured warning.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const built = buildObservability({
      ...BASE,
      logfire: { ...BASE.logfire, token: "pylf_v1_us_x" },
    });
    expect(built.observability).toBeDefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("registers both exporters when Langfuse and Logfire are both configured", () => {
    // Both backends share ONE config so a trace fans out to both, rather than
    // the registry selecting between two configs and one silently going dark.
    const built = buildObservability({
      ...withLangfuse(),
      logfire: { ...BASE.logfire, token: "pylf_v1_us_x" },
    });
    const instances = built.observability!.listInstances();
    expect([...instances.keys()]).toEqual(["tracing"]);
    expect(instances.get("tracing")!.getExporters()).toHaveLength(2);
  });

  it("flushes without throwing when an exporter is configured", async () => {
    const built = buildObservability({
      ...BASE,
      logfire: { ...BASE.logfire, token: "pylf_v1_us_x" },
    });
    await expect(built.flush()).resolves.toBeUndefined();
  });
});
