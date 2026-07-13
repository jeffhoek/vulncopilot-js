import { afterEach, describe, expect, it, vi } from "vitest";
import { buildObservability } from "./observability";

const BASE = { baseUrl: "https://cloud.langfuse.com", dev: true };

describe("buildObservability", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns undefined when no keys are set", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(buildObservability({ ...BASE })).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("returns undefined and warns when only the public key is set", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(buildObservability({ ...BASE, publicKey: "pk-lf-x" })).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("returns undefined and warns when only the secret key is set", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(buildObservability({ ...BASE, secretKey: "sk-lf-x" })).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("returns an Observability instance when both keys are set", () => {
    const obs = buildObservability({
      ...BASE,
      publicKey: "pk-lf-x",
      secretKey: "sk-lf-x",
    });
    expect(obs).toBeDefined();
  });
});
