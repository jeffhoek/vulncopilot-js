import { describe, expect, it } from "vitest";
import {
  fmtDuration,
  fmtRunAt,
  shapeLoader,
  shapeRun,
  type EtlLoaderRaw,
} from "./etl-stats";

// Port of the shaping in reference `rag/etl_stats.py`. The critical case is the
// public-exposure hardening: the raw per-loader `error` must NEVER reach output.
// getRecentEtlRuns hits the live DB and is exercised by the Phase 6 manual
// verification (DoD), matching the reference (which unit-tests only the shapers).

describe("fmtDuration (port of _fmt_duration)", () => {
  it("formats minutes and zero-padded seconds", () => {
    expect(fmtDuration(0)).toBe("0m00s");
    expect(fmtDuration(5)).toBe("0m05s");
    expect(fmtDuration(65)).toBe("1m05s");
    expect(fmtDuration(600)).toBe("10m00s");
  });

  it("truncates fractional seconds (divmod on int)", () => {
    expect(fmtDuration(12.9)).toBe("0m12s");
  });
});

describe("fmtRunAt", () => {
  it("renders the UTC wall-clock as YYYY-MM-DD HH:MM UTC", () => {
    expect(fmtRunAt(new Date("2026-07-09T23:31:05.000Z"))).toBe("2026-07-09 23:31 UTC");
  });

  it("accepts an ISO string too", () => {
    expect(fmtRunAt("2026-01-02T04:05:00.000Z")).toBe("2026-01-02 04:05 UTC");
  });
});

describe("shapeLoader — public-exposure hardening", () => {
  it("NEVER echoes the raw error field on a failed loader", () => {
    const loader: EtlLoaderRaw = {
      label: "kev",
      ok: false,
      elapsed: 3,
      summary: "loaded 0 rows",
      error: "connection to /var/secret/db failed: password=hunter2",
    };
    const shaped = shapeLoader(loader);
    expect(shaped.detail).toBe("failed");
    // The secret must not appear anywhere in the shaped output.
    expect(JSON.stringify(shaped)).not.toContain("hunter2");
    expect(JSON.stringify(shaped)).not.toContain("/var/secret");
    // Shaped output carries only the four safe fields.
    expect(Object.keys(shaped).sort()).toEqual(["detail", "elapsed", "label", "ok"]);
  });

  it("shows the summary line on a successful loader", () => {
    const shaped = shapeLoader({ label: "nvd", ok: true, elapsed: 90, summary: "loaded 1200 rows" });
    expect(shaped).toEqual({
      label: "nvd",
      ok: true,
      elapsed: "1m30s",
      detail: "loaded 1200 rows",
    });
  });

  it("does not surface the metrics field", () => {
    const shaped = shapeLoader({ label: "cwe", ok: true, elapsed: 1, metrics: { secretCount: 42 } });
    expect(JSON.stringify(shaped)).not.toContain("secretCount");
  });

  it("tolerates missing fields", () => {
    expect(shapeLoader({})).toEqual({ label: "", ok: false, elapsed: "0m00s", detail: "failed" });
  });
});

describe("shapeRun (port of _shape_run)", () => {
  const base = {
    run_at: new Date("2026-07-09T23:31:05.000Z"),
    total_elapsed: "125.50",
    results: [
      { label: "kev", ok: true, elapsed: 20, summary: "loaded 50" },
      { label: "nvd", ok: false, elapsed: 5, error: "boom /etc/passwd" },
    ] as EtlLoaderRaw[],
  };

  it("maps SUCCESS status to ok=true and shapes loaders", () => {
    const shaped = shapeRun({ ...base, status: "SUCCESS" });
    expect(shaped.ok).toBe(true);
    expect(shaped.runAt).toBe("2026-07-09 23:31 UTC");
    expect(shaped.totalElapsed).toBe("2m05s");
    expect(shaped.loaders[1].detail).toBe("failed");
    expect(JSON.stringify(shaped)).not.toContain("/etc/passwd");
  });

  it("maps a non-SUCCESS status to ok=false", () => {
    expect(shapeRun({ ...base, status: "FAILED" }).ok).toBe(false);
  });

  it("parses a JSON-string results column (defensive)", () => {
    const shaped = shapeRun({
      run_at: new Date("2026-07-09T00:00:00.000Z"),
      status: "SUCCESS",
      total_elapsed: 0,
      results: JSON.stringify([{ label: "kev", ok: true, elapsed: 1, summary: "ok" }]),
    });
    expect(shaped.loaders).toEqual([{ label: "kev", ok: true, elapsed: "0m01s", detail: "ok" }]);
  });
});
