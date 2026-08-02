import type { Pool } from "pg";

// Ported from reference `rag/risk.py` — the CONSUMER half only.
//
// The reference module owns the weights AND generates the `v_cve_risk` DDL from
// them, so the blend runs in exactly one place: Postgres. That half is
// deliberately NOT ported. This repo does not own schema DDL (CLAUDE.md scope
// boundary) — the Python ETL creates and refreshes the materialized view — and a
// second implementation of the same formula is precisely the drift the reference
// module was written to prevent. Nothing here sums anything: the view computes
// risk_score and the six c_* contributions, and this file reads them.
//
// What IS ported is everything downstream of the arithmetic: the band cut-points,
// the batch contract, and the prose (rationale + CWE class names). Those must
// match the reference or the two apps will describe the same score differently.

/** Band cut-points. Calibrated against the production corpus — see config.ts. */
const BAND_CRITICAL = 65;
const BAND_HIGH = 45;
const BAND_MODERATE = 25;

const BANDS: ReadonlyArray<readonly [number, string]> = [
  [BAND_CRITICAL, "critical"],
  [BAND_HIGH, "high"],
  [BAND_MODERATE, "moderate"],
];

const CVE_ID_PATTERN = /^CVE-\d{4}-\d{4,}$/;

// Token-budget judgment call, not a derived limit, and NOT what caps how many
// CVEs can be ranked: bulk ranking goes through `v_cve_risk` via the `query`
// tool (ORDER BY risk_score DESC), which has no cap. This tool exists to explain
// a shortlist, not to produce one — batching a long list through it in chunks of
// 25 is the anti-pattern the system prompt steers away from.
export const MAX_BATCH = 25;

const VIEW_NAME = "v_cve_risk";

/** Prior the view substitutes for a missing CVSS. Kept as the string the
 *  reference's Decimal("5.0") renders as, so the rationale text matches. */
const CVSS_MISSING_PRIOR = "5.0";

/** Delta above which an EPSS move is worth calling out in the rationale. */
const EPSS_MOVEMENT_THRESHOLD = 0.05;

// Class labels for the CWEs the view rates, used only for the rationale prose.
// The severities themselves live in the view (generated from the reference's
// CWE_CLASSES), so this map carries names alone — a severity copy here would be
// the drift the reference module exists to prevent.
const CWE_CLASSES: ReadonlyArray<readonly [string, readonly string[]]> = [
  [
    "Memory corruption",
    ["CWE-787", "CWE-119", "CWE-125", "CWE-416", "CWE-120", "CWE-121", "CWE-122", "CWE-190"],
  ],
  ["Injection / code execution", ["CWE-89", "CWE-78", "CWE-94", "CWE-74", "CWE-434", "CWE-77", "CWE-502"]],
  ["Access control / traversal", ["CWE-22", "CWE-862", "CWE-284", "CWE-863", "CWE-269", "CWE-59"]],
  ["Authentication bypass", ["CWE-287", "CWE-306", "CWE-288"]],
  ["Request forgery / XSS", ["CWE-352", "CWE-918", "CWE-79"]],
  ["Information disclosure", ["CWE-200", "CWE-203"]],
  ["DoS / resource exhaustion", ["CWE-400", "CWE-476"]],
];

const CWE_CLASS_NAME = new Map<string, string>(
  CWE_CLASSES.flatMap(([label, cwes]) => cwes.map((cwe) => [cwe, label] as const)),
);

/** A `v_cve_risk` row as node-postgres returns it: NUMERIC arrives as a string
 *  (never a float — that's the point), DATE as a Date, BOOLEAN as a boolean. */
export interface RiskRow {
  cve_id: string;
  risk_score: string | number | null;
  c_cvss: string | number | null;
  c_epss: string | number | null;
  c_kev: string | number | null;
  c_ransomware: string | number | null;
  c_ssvc: string | number | null;
  c_cwe: string | number | null;
  cvss_score: string | number | null;
  cvss_imputed: boolean | null;
  epss_probability: string | number | null;
  epss_percentile: string | number | null;
  epss_previous_probability: string | number | null;
  epss_previous_scored_at: Date | string | null;
  epss_scored_at: Date | string | null;
  kev_listed: boolean | null;
  kev_date_added: Date | string | null;
  known_ransomware_campaign_use: string | null;
  ssvc_exploitation: string | null;
  ssvc_automatable: string | null;
  ssvc_technical_impact: string | null;
  cwe_top: string | null;
}

/** Each signal's weighted contribution, 0-1. Sums to the score / 100. */
export interface RiskComponents {
  cvss: number;
  epss: number;
  kev: number;
  ransomware: number;
  ssvc: number;
  cwe: number;
}

/**
 * One CVE's composite risk. `score`, `band`, and `components` are null only when
 * the CVE is in neither KEV nor NVD — an unknown ID is reported explicitly rather
 * than dropped, because a silently missing row in a ranking reads as "low risk".
 */
export interface RiskScore {
  cve_id: string;
  score: number | null;
  band: string | null;
  components: RiskComponents | null;
  rationale: string;
}

/** Return the band label for a 0-100 composite score. */
export function band(score: number): string {
  for (const [cut, label] of BANDS) {
    if (score >= cut) return label;
  }
  return "low";
}

/**
 * Return an error string if the batch is unusable, else null.
 *
 * The regex is the input contract, not a security control — IDs reach the
 * database as a query parameter, never as interpolated SQL.
 */
export function validateCveIds(cveIds: string[]): string | null {
  if (cveIds.length === 0) {
    return "Error: no CVE IDs supplied.";
  }
  if (cveIds.length > MAX_BATCH) {
    return `Error: at most ${MAX_BATCH} CVE IDs per call, got ${cveIds.length}.`;
  }
  const bad = cveIds.filter((c) => !CVE_ID_PATTERN.test(c));
  if (bad.length > 0) {
    return `Error: malformed CVE ID(s): ${bad.join(", ")}. Expected the form CVE-2021-44228.`;
  }
  return null;
}

/**
 * Round a decimal to a whole number after shifting the point `shift` places
 * right, half-up (away from zero at exactly .5) — Python's ROUND_HALF_UP.
 *
 * Done on the decimal STRING pg hands us rather than via float math, which is a
 * real divergence and not pedantry. The reference works in Decimal, where
 * `Decimal("0.635") * 100` is exactly `63.5` and rounds half-up to 64. In
 * IEEE-754 that same product is 63.49999999999999 and `Math.round` gives 63 —
 * the two apps would then report different scores for the same row. Nor does
 * `Math.round` round half-up on its own for negatives. Shifting the point on the
 * digit string sidesteps both.
 */
function decimalRound(value: string | number | null | undefined, shift: number): number {
  const text = String(value ?? 0).trim();
  const match = /^(-?)(\d*)(?:\.(\d*))?$/.exec(text);
  if (!match) {
    // Exponential notation or junk. Nothing in v_cve_risk produces either;
    // fall back rather than throw inside a tool.
    const n = Number(text) * 10 ** shift;
    return Number.isFinite(n) ? Math.round(n) : 0;
  }
  const [, sign, whole, fraction = ""] = match;
  const digits = `${whole}${fraction}`;
  const pointAt = whole.length + shift;
  const padded = digits.padEnd(pointAt, "0");
  const shiftedWhole = padded.slice(0, pointAt) || "0";
  const shiftedFraction = padded.slice(pointAt);
  const roundUp = shiftedFraction.charCodeAt(0) >= "5".charCodeAt(0);
  const magnitude = Number(shiftedWhole) + (roundUp ? 1 : 0);
  return sign === "-" ? -magnitude : magnitude;
}

/** A weighted component (0-1) as whole points out of 100, rounded half-up. */
export function toPoints(value: string | number | null | undefined): number {
  return decimalRound(value, 2);
}

/** A 0-100 composite score as a whole number, rounded half-up. */
export function scorePoints(value: string | number | null | undefined): number {
  return decimalRound(value, 0);
}

function num(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isNaN(n) ? null : n;
}

/**
 * `YYYY-MM-DD` from a pg DATE. node-postgres parses DATE to a Date at LOCAL
 * midnight, so `toISOString()` would report the previous day at any positive UTC
 * offset. Read the local fields instead.
 */
function fmtDate(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (!(value instanceof Date)) return String(value);
  const y = value.getFullYear();
  const m = String(value.getMonth() + 1).padStart(2, "0");
  const d = String(value.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function kevClause(row: RiskRow): string | null {
  if (!row.kev_listed) return null;
  let text = "Listed in KEV";
  const dateAdded = fmtDate(row.kev_date_added);
  if (dateAdded !== null) {
    text += ` since ${dateAdded}`;
  }
  if (row.known_ransomware_campaign_use === "Known") {
    text += " with known ransomware campaign use";
  }
  return text;
}

function epssClause(row: RiskRow): string {
  const probability = num(row.epss_probability);
  if (probability === null) {
    return "No EPSS score — this signal contributed nothing, it is not a low likelihood";
  }

  let text = `EPSS ${probability.toFixed(5)}`;
  const details: string[] = [];
  const percentile = num(row.epss_percentile);
  if (percentile !== null) {
    details.push(`${(percentile * 100).toFixed(0)}th percentile`);
  }
  const scoredAt = fmtDate(row.epss_scored_at);
  if (scoredAt !== null) {
    details.push(`as of ${scoredAt}`);
  }
  if (details.length > 0) {
    text += ` (${details.join(", ")})`;
  }

  const previous = num(row.epss_previous_probability);
  if (previous !== null && Math.abs(probability - previous) >= EPSS_MOVEMENT_THRESHOLD) {
    const direction = probability > previous ? "rose" : "fell";
    text += ` — EPSS ${direction} ${previous.toFixed(5)} → ${probability.toFixed(5)}`;
    const previousAt = fmtDate(row.epss_previous_scored_at);
    if (previousAt !== null) {
      text += ` since ${previousAt}`;
    }
  }
  return text;
}

function cvssClause(row: RiskRow): string {
  if (row.cvss_imputed) {
    return `CVSS unassessed — scored at the neutral ${CVSS_MISSING_PRIOR} prior`;
  }
  // Rendered from the raw pg string, not Number(): "10.0" must not become "10".
  return row.cvss_score !== null && row.cvss_score !== undefined
    ? `CVSS ${row.cvss_score}`
    : "CVSS unavailable";
}

function ssvcClause(row: RiskRow): string | null {
  const factors: Array<[string, string | null]> = [
    ["exploitation", row.ssvc_exploitation],
    ["automatable", row.ssvc_automatable],
    ["technical impact", row.ssvc_technical_impact],
  ];
  const present = factors
    .filter(([, value]) => Boolean(value))
    .map(([label, value]) => `${label}=${value}`);
  return present.length > 0 ? `SSVC ${present.join(", ")}` : null;
}

function cweClause(row: RiskRow): string {
  const cwe = row.cwe_top;
  if (cwe === null || cwe === undefined) {
    return "No rated weakness class — scored at the neutral default";
  }
  return `${CWE_CLASS_NAME.get(cwe) ?? "Weakness"} class, ${cwe}`;
}

/**
 * Explain a `v_cve_risk` row in prose, clauses ranked by contribution.
 *
 * The score alone is a black box; the score beside its ranked contributions is
 * an argument.
 *
 * Each clause's points are rounded independently, so they can sum to within a
 * point of the headline score (a 0.125 CVSS component reads as "+13", not
 * "+12.5"). That is a deliberate readability trade, not a rounding bug — the
 * exact values are in the c_* view columns and in RiskScore.components.
 */
export function buildRationale(row: RiskRow): string {
  const score = num(row.risk_score) ?? 0;
  const component = (value: string | number | null): number => num(value) ?? 0;

  // KEV listing and the ransomware flag read as one fact, so they share a clause
  // and their contributions are summed for ranking.
  const kevContribution = component(row.c_kev) + component(row.c_ransomware);

  // [contribution, clause, keepAtZero]. A clause that contributed nothing is
  // dropped — except a missing EPSS score, which has to be said out loud, since
  // a silently absent likelihood signal reads as "low likelihood".
  const candidates: Array<[number, string | null, boolean]> = [
    [kevContribution, kevClause(row), false],
    [component(row.c_epss), epssClause(row), row.epss_probability === null],
    [component(row.c_cvss), cvssClause(row), true],
    [component(row.c_ssvc), ssvcClause(row), false],
    [component(row.c_cwe), cweClause(row), false],
  ];

  const parts = candidates
    .slice()
    .sort((a, b) => b[0] - a[0])
    .filter(([contribution, clause, keepAtZero]) => clause !== null && (contribution > 0 || keepAtZero))
    .map(([contribution, clause]) => `${clause} (+${toPoints(contribution)}).`);

  const label = band(score);
  const header = `${label.charAt(0).toUpperCase()}${label.slice(1)} (${scorePoints(row.risk_score)}).`;
  return [header, ...parts].join(" ");
}

/** Build a RiskScore from a `v_cve_risk` row. No blending — the view did that. */
export function rowToRiskScore(row: RiskRow): RiskScore {
  const score = num(row.risk_score) ?? 0;
  return {
    cve_id: row.cve_id,
    // Rounded off the raw pg decimal string, not the parsed float — see decimalRound.
    score: scorePoints(row.risk_score),
    band: band(score),
    components: {
      cvss: Number(row.c_cvss),
      epss: Number(row.c_epss),
      kev: Number(row.c_kev),
      ransomware: Number(row.c_ransomware),
      ssvc: Number(row.c_ssvc),
      cwe: Number(row.c_cwe),
    },
    rationale: buildRationale(row),
  };
}

// Parameterized, never interpolated. This tool builds its own SQL and so does
// not pass through validateSql() — the bound parameter is the only thing between
// a tool argument and the database.
const RISK_QUERY = `SELECT * FROM ${VIEW_NAME} WHERE cve_id = ANY($1::text[])`;

/**
 * Score a batch of CVEs against `v_cve_risk`, ranked highest-risk first.
 *
 * Returns an error string rather than throwing when the batch is unusable, so
 * both tool surfaces (agent and MCP) report the same message to the model.
 *
 * Takes the pool as an argument, mirroring the reference signature, so this
 * module stays free of the config/db import chain and unit-testable without env.
 */
export async function scoreCves(pool: Pool, cveIds: string[]): Promise<RiskScore[] | string> {
  const error = validateCveIds(cveIds);
  if (error) {
    return error;
  }

  const result = await pool.query<RiskRow>(RISK_QUERY, [cveIds]);

  const scored = result.rows
    .map(rowToRiskScore)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  const found = new Set(scored.map((r) => r.cve_id));
  const missing: RiskScore[] = [...new Set(cveIds)]
    .filter((cveId) => !found.has(cveId))
    .map((cveId) => ({
      cve_id: cveId,
      score: null,
      band: null,
      components: null,
      rationale: "Not found in KEV or NVD — unscored, not low risk.",
    }));

  return [...scored, ...missing];
}
