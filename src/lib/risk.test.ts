import { describe, expect, it } from "vitest";
import {
  band,
  buildRationale,
  MAX_BATCH,
  type RiskRow,
  rowToRiskScore,
  scoreCves,
  scorePoints,
  toPoints,
  validateCveIds,
} from "./risk";

// Ported from reference tests/unit/test_risk.py and test_risk_tool.py, minus the
// DDL-generation half (this repo does not own the view — see risk.ts).

/** A v_cve_risk row shaped the way node-postgres returns one: NUMERIC as a
 *  decimal string, DATE as a Date, BOOLEAN as a boolean. */
function row(overrides: Partial<RiskRow> = {}): RiskRow {
  return {
    cve_id: "CVE-2021-44228",
    risk_score: "100.0",
    c_cvss: "0.2500",
    c_epss: "0.3000",
    c_kev: "0.20",
    c_ransomware: "0.10",
    c_ssvc: "0.10",
    c_cwe: "0.0500",
    cvss_score: "10.0",
    cvss_imputed: false,
    epss_probability: "1.00000",
    epss_percentile: "1.00000",
    epss_previous_probability: null,
    epss_previous_scored_at: null,
    epss_scored_at: new Date(2026, 6, 29),
    kev_listed: true,
    kev_date_added: new Date(2021, 11, 10),
    known_ransomware_campaign_use: "Known",
    ssvc_exploitation: "active",
    ssvc_automatable: "yes",
    ssvc_technical_impact: "total",
    cwe_top: "CWE-502",
    ...overrides,
  };
}

describe("band", () => {
  it("maps scores to the calibrated cut-points", () => {
    expect(band(100)).toBe("critical");
    expect(band(65)).toBe("critical");
    expect(band(64.9)).toBe("high");
    expect(band(45)).toBe("high");
    expect(band(44.9)).toBe("moderate");
    expect(band(25)).toBe("moderate");
    expect(band(24.9)).toBe("low");
    expect(band(0)).toBe("low");
  });

  it("keeps the measured non-KEV ceiling inside the high band", () => {
    // Load-bearing calibration assertion (reference plans/composite-risk-score.md
    // §10d): ssvc_exploitation='active' is a KEV alias, so a non-KEV CVE tops out
    // at 63.5 against the production corpus. If that lands in "moderate", the
    // early-warning query this feature exists for returns mislabelled rows.
    expect(band(63.5)).toBe("high");
  });
});

describe("decimal rounding", () => {
  it("rounds components half-up on the decimal string, not the float", () => {
    // 0.245 * 100 is 24.500000000000004 in IEEE-754 and 0.635 * 100 is
    // 63.49999999999999 — the second is the one that would silently disagree
    // with the Python side.
    expect(toPoints("0.245")).toBe(25);
    expect(toPoints("0.635")).toBe(64);
    expect(toPoints("0.2500")).toBe(25);
    expect(toPoints("0.0405")).toBe(4);
    expect(toPoints(null)).toBe(0);
    expect(toPoints("0")).toBe(0);
  });

  it("rounds a 0-100 score without shifting it", () => {
    expect(scorePoints("100.0")).toBe(100);
    expect(scorePoints("63.5")).toBe(64);
    expect(scorePoints("24.4")).toBe(24);
    expect(scorePoints(null)).toBe(0);
  });
});

describe("validateCveIds", () => {
  it("accepts a well-formed batch", () => {
    expect(validateCveIds(["CVE-2021-44228", "CVE-2017-0144"])).toBeNull();
  });

  it("rejects an empty batch", () => {
    expect(validateCveIds([])).toBe("Error: no CVE IDs supplied.");
  });

  it("rejects a batch over the cap", () => {
    const ids = Array.from({ length: MAX_BATCH + 1 }, (_, i) => `CVE-2021-${10000 + i}`);
    expect(validateCveIds(ids)).toBe(
      `Error: at most ${MAX_BATCH} CVE IDs per call, got ${MAX_BATCH + 1}.`,
    );
  });

  it("rejects malformed IDs and names them", () => {
    expect(validateCveIds(["CVE-2021-44228", "log4shell", "CVE-21-1"])).toBe(
      "Error: malformed CVE ID(s): log4shell, CVE-21-1. Expected the form CVE-2021-44228.",
    );
  });
});

describe("rowToRiskScore", () => {
  it("reads the view's numbers rather than recomputing them", () => {
    const result = rowToRiskScore(row());
    expect(result).toMatchObject({
      cve_id: "CVE-2021-44228",
      score: 100,
      band: "critical",
      components: { cvss: 0.25, epss: 0.3, kev: 0.2, ransomware: 0.1, ssvc: 0.1, cwe: 0.05 },
    });
    // The six contributions must reconcile with the headline score, or the
    // breakdown is worse than no breakdown.
    const sum = Object.values(result.components!).reduce((a, b) => a + b, 0);
    expect(sum * 100).toBeCloseTo(result.score!, 6);
  });
});

describe("buildRationale", () => {
  it("ranks clauses by contribution and leads with the band", () => {
    const text = buildRationale(row());
    expect(text).toBe(
      "Critical (100). Listed in KEV since 2021-12-10 with known ransomware campaign use (+30). " +
        "EPSS 1.00000 (100th percentile, as of 2026-07-29) (+30). CVSS 10.0 (+25). " +
        "SSVC exploitation=active, automatable=yes, technical impact=total (+10). " +
        "Injection / code execution class, CWE-502 (+5).",
    );
  });

  it("says a missing EPSS score out loud instead of dropping it", () => {
    // A silently absent likelihood signal reads as "low likelihood" — the one
    // zero-contribution clause that must survive the filter.
    const text = buildRationale(
      row({ risk_score: "70.0", c_epss: "0.0000", epss_probability: null, epss_percentile: null, epss_scored_at: null }),
    );
    expect(text).toContain("No EPSS score — this signal contributed nothing, it is not a low likelihood (+0).");
  });

  it("flags an imputed CVSS as unassessed rather than as a measured 5.0", () => {
    const text = buildRationale(row({ cvss_imputed: true, cvss_score: null, c_cvss: "0.1250" }));
    expect(text).toContain("CVSS unassessed — scored at the neutral 5.0 prior (+13).");
  });

  it("drops zero-contribution clauses that carry no meaning", () => {
    const text = buildRationale(
      row({
        risk_score: "40.0",
        kev_listed: false,
        kev_date_added: null,
        known_ransomware_campaign_use: null,
        c_kev: "0.00",
        c_ransomware: "0.00",
        ssvc_exploitation: null,
        ssvc_automatable: null,
        ssvc_technical_impact: null,
        c_ssvc: "0",
      }),
    );
    expect(text).not.toContain("KEV");
    expect(text).not.toContain("SSVC");
    expect(text.startsWith("Moderate (40).")).toBe(true);
  });

  it("calls out an EPSS move past the threshold", () => {
    const text = buildRationale(
      row({
        epss_probability: "0.42000",
        epss_previous_probability: "0.10000",
        epss_previous_scored_at: new Date(2026, 6, 1),
      }),
    );
    expect(text).toContain("EPSS rose 0.10000 → 0.42000 since 2026-07-01");
  });

  it("ignores an EPSS move below the threshold", () => {
    const text = buildRationale(
      row({ epss_probability: "0.42000", epss_previous_probability: "0.40000" }),
    );
    expect(text).not.toContain("rose");
  });

  it("names an unrated weakness class as neutral, not absent", () => {
    expect(buildRationale(row({ cwe_top: null }))).toContain(
      "No rated weakness class — scored at the neutral default",
    );
  });
});

describe("scoreCves", () => {
  /** Minimal pg Pool stand-in — the query is parameterized, so the fake only
   *  has to echo back rows for the IDs it is asked about. */
  function fakePool(rows: RiskRow[]) {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    return {
      calls,
      query: async (sql: string, params: unknown[]) => {
        calls.push({ sql, params });
        return { rows };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  }

  it("ranks highest-risk first and passes IDs as a bound parameter", async () => {
    const pool = fakePool([
      row({ cve_id: "CVE-2017-0144", risk_score: "40.0" }),
      row({ cve_id: "CVE-2021-44228", risk_score: "100.0" }),
    ]);
    const result = await scoreCves(pool, ["CVE-2017-0144", "CVE-2021-44228"]);

    expect(Array.isArray(result)).toBe(true);
    expect((result as Array<{ cve_id: string }>).map((r) => r.cve_id)).toEqual([
      "CVE-2021-44228",
      "CVE-2017-0144",
    ]);
    // The IDs must never be interpolated into the SQL text.
    expect(pool.calls[0].sql).not.toContain("CVE-");
    expect(pool.calls[0].params).toEqual([["CVE-2017-0144", "CVE-2021-44228"]]);
  });

  it("reports an unknown CVE as unscored rather than dropping it", async () => {
    const pool = fakePool([row()]);
    const result = (await scoreCves(pool, ["CVE-2021-44228", "CVE-1999-9999"])) as Array<{
      cve_id: string;
      score: number | null;
      rationale: string;
    }>;

    expect(result).toHaveLength(2);
    expect(result[1]).toEqual({
      cve_id: "CVE-1999-9999",
      score: null,
      band: null,
      components: null,
      rationale: "Not found in KEV or NVD — unscored, not low risk.",
    });
  });

  it("returns the validation error without touching the database", async () => {
    const pool = fakePool([]);
    expect(await scoreCves(pool, [])).toBe("Error: no CVE IDs supplied.");
    expect(pool.calls).toHaveLength(0);
  });
});
