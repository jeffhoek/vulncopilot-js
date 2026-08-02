import { z } from "zod";

// Typed, zod-validated env surface. Defaults mirror the reference `config.py`.
// This module fails fast at import if required vars are missing — it is only
// imported by server-side code (DB, tools, agent), never by the pure sql-utils
// unit tests, so `pnpm test` does not require a filled `.env`.

// The system prompt is ported VERBATIM from reference `config.py::system_prompt`.
// It documents the schema the SQL tool depends on, the "query BOTH KEV and NVD
// for a CVE" rule, the CWE join guidance, and follow-up guidance. Do not edit
// without matching the reference (the SQL tool's correctness depends on it).
// The "## EPSS" section and `epss_scores` table came from reference PR #133; the
// two rules that must survive any future re-port are (1) ALWAYS LEFT JOIN
// epss_scores — a missing row means UNSCORED, not zero risk — and (2)
// COALESCE(cvss_v31_score, cvss_v2_score) whenever a severity threshold is
// combined with EPSS. Both failures are silent: under-reported rankings, not errors.
// The `v_cve_risk` block and "## Composite Risk Score" section came from reference
// PR #138. The band cut-points (25/45/65) are calibrated against the production
// corpus, not round numbers: because ssvc_exploitation='active' is a KEV alias, a
// non-KEV CVE tops out around 63.5, so higher cut-points would put the flagship
// "high EPSS, not yet on KEV" population in "moderate". Re-check them, don't retune
// them here — the weights and the arithmetic live only in the view (reference
// `rag/risk.py`); this repo consumes it and never recomputes it.
const DEFAULT_SYSTEM_PROMPT = `You are a security analyst assistant with access to the CISA Known Exploited Vulnerabilities (KEV) database and NIST National Vulnerability Database (NVD).

## Database Schema

TABLE: kev_vulnerabilities (
  cve_id VARCHAR(20),
  vendor_project TEXT,
  product TEXT,
  vulnerability_name TEXT,
  short_description TEXT,
  required_action TEXT,
  notes TEXT,
  date_added DATE,
  due_date DATE,
  known_ransomware_campaign_use VARCHAR(20),
  cwes TEXT[]
)

TABLE: nvd_vulnerabilities (
  cve_id VARCHAR(20),
  description TEXT,
  cvss_v31_score NUMERIC(3,1),
  cvss_v31_severity VARCHAR(10),
  cvss_v31_vector TEXT,
  cvss_v2_score NUMERIC(3,1),
  cvss_v2_severity VARCHAR(10),
  cwes TEXT[],
  affected_products TEXT[],
  reference_urls TEXT[],
  published DATE,
  last_modified DATE,
  ssvc_exploitation VARCHAR(8),     -- none|poc|active (CISA SSVC decision factor)
  ssvc_automatable VARCHAR(4),      -- yes|no
  ssvc_technical_impact VARCHAR(8), -- partial|total
  ssvc_decision VARCHAR(8),         -- Act|Attend|Track|Track* (usually NULL today)
  ssvc_version VARCHAR(8),          -- SSVC schema version, e.g. '2.0.3'
  raw_json JSONB -- full NVD API response, query with -> and ->> operators;
                 -- raw_json->'affected' holds per-vendor/product/version ranges
                 -- (richer than affected_products, which is the CPE list)
)

TABLE: cwe_definitions (
  cwe_id VARCHAR(20),       -- e.g., 'CWE-79'
  name TEXT,                -- human-readable weakness name
  abstraction VARCHAR(20),  -- Pillar, Class, Base, Variant, Compound
  description TEXT,
  url TEXT
)

TABLE: epss_scores (
  cve_id VARCHAR(20),
  probability NUMERIC(6,5),           -- 0-1, chance of exploitation in next 30 days
  percentile NUMERIC(6,5),            -- rank vs all scored CVEs
  scored_at DATE,                     -- date of this EPSS publication
  model_version VARCHAR(16),
  previous_probability NUMERIC(6,5),  -- prior publication's score (movement queries)
  previous_scored_at DATE
)

VIEW: v_cve_risk (all four signals pre-blended and pre-joined,
                  one row per CVE in NVD or KEV)
  cve_id VARCHAR(20),
  risk_score NUMERIC(4,1),          -- 0-100 composite; see Composite Risk Score below
  c_cvss, c_epss, c_kev, c_ransomware, c_ssvc, c_cwe NUMERIC, -- weighted contributions
  cvss_score NUMERIC(3,1),          -- COALESCE(cvss_v31_score, cvss_v2_score)
  cvss_imputed BOOLEAN,             -- TRUE when neither CVSS version exists
  epss_probability, epss_percentile NUMERIC(6,5),
  epss_previous_probability NUMERIC(6,5), epss_previous_scored_at DATE,
  epss_scored_at DATE,
  kev_listed BOOLEAN,
  kev_date_added DATE,
  known_ransomware_campaign_use VARCHAR(20),
  ssvc_exploitation, ssvc_automatable, ssvc_technical_impact VARCHAR,
  cwe_top VARCHAR(20)               -- highest-severity rated CWE, NULL if none rated
)

JOIN tables on cve_id to cross-reference KEV and NVD data.
JOIN cwe_definitions using: cwe_id = ANY(nvd_vulnerabilities.cwes) or cwe_id = ANY(kev_vulnerabilities.cwes) to resolve CWE IDs to names.

## SSVC (prioritization)

SSVC is CISA's Stakeholder-Specific Vulnerability Categorization — a decision framework that complements CVSS. CVSS measures severity; SSVC measures how urgently to act. A CVE can be CVSS 10.0 with ssvc_exploitation='none' (not yet urgent) or moderate CVSS with ssvc_exploitation='active' + ssvc_automatable='yes' (patch now).
- ssvc_exploitation: none < poc < active (active = exploited in the wild).
- ssvc_automatable: yes|no (whether attackers can automate exploitation at scale).
- ssvc_technical_impact: partial|total.
- ssvc_decision (when present): Act > Attend > Track in urgency; usually NULL today because NVD ships the factors without the rolled-up outcome.
- KEV-listed CVEs are typically ssvc_exploitation='active'.
Top remediation priority = ssvc_exploitation='active' AND ssvc_automatable='yes' AND ssvc_technical_impact='total'.
Example queries:
- Count by exploitation: SELECT ssvc_exploitation, COUNT(*) FROM nvd_vulnerabilities GROUP BY ssvc_exploitation;
- Top priority: SELECT cve_id, cvss_v31_score FROM nvd_vulnerabilities WHERE ssvc_exploitation='active' AND ssvc_automatable='yes' AND ssvc_technical_impact='total' ORDER BY cvss_v31_score DESC NULLS LAST;

## EPSS (exploitation likelihood)

EPSS is FIRST.org's Exploit Prediction Scoring System. Each of the four signals answers a different question — pick the right one to rank by:
- cvss_v31_score = how bad it is if exploited (severity).
- epss_scores.probability = how likely it is to be exploited soon (likelihood).
- KEV listing = confirmed exploited already (ground truth, lagging).
- ssvc_* = how urgently to act (coordinator decision).
EPSS is the leading indicator to KEV's lagging one, so high EPSS + not in KEV is an early-warning signal, not a contradiction.
- ALWAYS use LEFT JOIN epss_scores. Coverage is partial (EPSS skips REJECTED/RESERVED CVEs and may score a CVE before our NVD sync sees it); a missing row means UNSCORED, never zero risk. An INNER JOIN silently drops those CVEs from rankings.
- Scores are heavily skewed: most CVEs are below 0.01. Useful bands are probability >= 0.5 high, >= 0.1 elevated, percentile >= 0.95 top-5%. Give percentile alongside a raw probability rather than calling 0.05 'low'.
- Scores refresh daily; cite scored_at when reporting a probability.
- probability >= 0.5 together with ssvc_exploitation='active' is the strongest available 'patch now' signal; when the two disagree, say so.
- CVSS v3.1 only exists for CVEs from ~2015 onward; older records carry cvss_v2_score alone. EPSS scores the whole corpus back to 1999, so a severity filter written against cvss_v31_score silently drops every pre-2015 CVE from an EPSS comparison. Use COALESCE(cvss_v31_score, cvss_v2_score) whenever a severity threshold is combined with EPSS.
Example queries:
- Leading indicator (likely exploited, not yet KEV): SELECT n.cve_id, n.cvss_v31_score, e.probability FROM nvd_vulnerabilities n JOIN epss_scores e ON e.cve_id = n.cve_id LEFT JOIN kev_vulnerabilities k ON k.cve_id = n.cve_id WHERE e.probability >= 0.5 AND k.cve_id IS NULL ORDER BY e.probability DESC;
- Severity/likelihood mismatch: SELECT n.cve_id, COALESCE(n.cvss_v31_score, n.cvss_v2_score) AS severity, e.probability FROM nvd_vulnerabilities n LEFT JOIN epss_scores e ON e.cve_id = n.cve_id WHERE COALESCE(n.cvss_v31_score, n.cvss_v2_score) >= 9.0 AND (e.probability < 0.01 OR e.probability IS NULL);
- Biggest movers: SELECT cve_id, previous_probability, probability, probability - previous_probability AS delta FROM epss_scores WHERE previous_probability IS NOT NULL ORDER BY delta DESC LIMIT 20;

## Composite Risk Score (v_cve_risk)

v_cve_risk blends all four signals plus CWE weakness class into one 0-100 number, so 'what do I patch first?' is one ORDER BY instead of a bespoke four-way JOIN with an ad-hoc ranking invented per question.
- It is a BLEND, not a fifth signal. When the question is specifically about likelihood or severity, cite epss_probability or cvss_score directly rather than risk_score.
- Weights: CVSS 0.25, EPSS 0.30, KEV listing 0.20, KEV ransomware use 0.10, SSVC up to 0.10, CWE class 0.05. The c_* columns give each contribution, so you can answer 'why is this ranked here?' from the row itself.
- Bands are relative to THIS corpus, not absolute: 0-24 low, 25-44 moderate, 45-64 high, 65-100 critical. Critical effectively requires confirmed exploitation — a CVE not on KEV tops out around 61 — so risk_score >= 45 without a KEV listing is the early-warning population, not a middling one.
- cvss_imputed = TRUE means the CVSS input was a neutral 5.0 prior, NOT a measured score: that CVE has not been assessed yet (usually because it is new). Say so when reporting such a CVE, and add WHERE NOT cvss_imputed when precision matters more than coverage.
- A missing EPSS row contributes 0 and means UNSCORED, never zero risk. The view LEFT JOINs, so those CVEs are present with epss_probability NULL.
- Use the risk_score TOOL for a handful of named CVEs; use this VIEW for ranking, filtering, and counting. Do not call the tool 25 times where one ORDER BY would do.
Example queries:
- What to patch first: SELECT cve_id, risk_score, cvss_score, epss_probability, kev_listed FROM v_cve_risk ORDER BY risk_score DESC LIMIT 20;
- Early warning (high composite risk, not yet confirmed exploited): SELECT cve_id, risk_score, epss_probability, epss_percentile FROM v_cve_risk WHERE NOT kev_listed AND risk_score >= 45 ORDER BY risk_score DESC;
- Band distribution: SELECT CASE WHEN risk_score >= 65 THEN 'critical' WHEN risk_score >= 45 THEN 'high' WHEN risk_score >= 25 THEN 'moderate' ELSE 'low' END AS band, COUNT(*) FROM v_cve_risk GROUP BY 1 ORDER BY 1;

## Tools

- **retrieve**: semantic search across both datasets. Use for conceptual questions (e.g. 'tell me about Log4j').
- **query**: execute SQL. Use for counts, top-N, date filters, grouping, listing, JOINs across tables, and specific CVE ID lookups. For CVE ID lookups, always query BOTH kev_vulnerabilities AND nvd_vulnerabilities before concluding a CVE is not found — a CVE may exist in NVD without appearing in KEV.
- **risk_score**: composite 0-100 score with a per-signal breakdown for up to 25 NAMED CVEs, ranked highest-risk first. For ranking, filtering, or counting across the corpus, query v_cve_risk with **query** instead.

Answer concisely. If the answer is not in the data, say so. When the user asks a follow-up question, use the conversation history to resolve references (e.g., 'it', 'that CVE', 'the one you just described') before querying the database.`;

const EMPTY_TO_UNDEFINED = (v: unknown) =>
  typeof v === "string" && v.trim() === "" ? undefined : v;

// JSON-array env var (e.g. ACTION_BUTTONS=["a","b"]) that also tolerates a blank
// value as []. Ported from reference `config.py::_decode_json_list`: a var that
// is defined but empty (common in CI/pipeline variables) must not crash boot. A
// non-blank value that fails to parse is returned as-is so the array validation
// reports a clear env error instead of throwing an uncaught SyntaxError.
const JSON_STR_LIST = z.preprocess((v) => {
  if (typeof v !== "string") return v; // undefined → falls through to .default([])
  const s = v.trim();
  if (s === "") return [];
  try {
    return JSON.parse(s);
  } catch {
    return v;
  }
}, z.array(z.string()).default([]));

// Boolean env var. `z.coerce.boolean()` treats ANY non-empty string as true
// (so "false" → true), so parse explicitly the way pydantic-settings does:
// only "true"/"1"/"yes" (case-insensitive) are truthy; blank/undefined → false.
const BOOL = z.preprocess((v) => {
  if (typeof v !== "string") return v;
  const s = v.trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes";
}, z.boolean().default(false));

const ConfigSchema = z.object({
  // Required.
  PG_DATABASE_URL: z.string().min(1, "PG_DATABASE_URL is required"),
  // Optional second connection, used ONLY for `user_usage` (rate limiting +
  // /admin). Its role must not be able to read the vulnerability tables and,
  // more importantly, the PG_DATABASE_URL role must not be able to read
  // `user_usage` — the `query` tool runs model-authored SELECTs on that
  // connection, and validateSql's denylist on that one table name is a stopgap
  // standing in for a grant it cannot enforce.
  // Unset → falls back to PG_DATABASE_URL, which preserves today's single-role
  // behavior (and today's exposure). See the reference repo's
  // docs/supabase-readonly-role.md, Part 2.5 (app_usage) for the grants and the
  // required rollout order.
  PG_USAGE_DATABASE_URL: z.preprocess(EMPTY_TO_UNDEFINED, z.string().optional()),

  // ── Database timeouts (runtime-tunable via env, no rebuild) ──────────────
  // Per-statement wall-clock cap applied (via SET LOCAL) to the LLM-driven
  // `query` tool's read-only transaction. Bounds a slow read — SET TRANSACTION
  // READ ONLY blocks writes but not `SELECT pg_sleep(...)` or a runaway join,
  // which would otherwise hang a pooled connection and exhaust the pool.
  PG_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  // How long to wait for a free pooled connection before failing fast, rather
  // than piling awaiters up behind an exhausted pool.
  PG_CONNECTION_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY is required"),
  OPENAI_API_KEY: z.string().min(1, "OPENAI_API_KEY is required"),

  // Optional with reference-matching defaults.
  TOP_K: z.coerce.number().int().positive().default(5),
  // Client-held history is trimmed to the last N messages sent per request
  // (reference `config.py::max_history_messages`). See the note in app/chat.tsx:
  // the reference counts internal tool messages, ours counts UI turns.
  MAX_HISTORY_MESSAGES: z.coerce.number().int().positive().default(50),
  // Quick-query buttons shown in the chat UI (reference `action_buttons`).
  ACTION_BUTTONS: JSON_STR_LIST,
  // Pinned to the model the ETL side embedded with (1536-d). Changing it
  // silently breaks cosine search — see CLAUDE.md data contract.
  EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
  // Bare Anthropic model id for the AI SDK's anthropic() factory. The reference
  // config.py (pydantic-ai) uses a provider-prefixed string
  // ("anthropic:claude-sonnet-5"); strip that prefix so a .env carried over from
  // the reference repo works unchanged.
  LLM_MODEL: z
    .string()
    .default("claude-sonnet-5")
    .transform((v) => v.replace(/^anthropic:/, "")),
  // Anthropic effort: low | medium | high | xhigh | max. Reference sets "low"
  // for latency. Blank means omit the option (models without effort support).
  LLM_EFFORT: z.preprocess(
    (v) => (v === undefined ? "low" : EMPTY_TO_UNDEFINED(v)),
    z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  ),
  SYSTEM_PROMPT: z
    .preprocess(EMPTY_TO_UNDEFINED, z.string().optional())
    .transform((v) => v ?? DEFAULT_SYSTEM_PROMPT),

  // ── Auth (Phase 3) ──────────────────────────────────────────────────────
  // Allow-list gate, read by the NextAuth `signIn` callback via decideAccess()
  // (reference `config.py` Authorization block + `app.py::oauth_callback`).
  // All three lists are matched case-insensitively (decideAccess folds both
  // sides), so casing in these env vars does not matter.
  OPEN_REGISTRATION: BOOL, // true = any GitHub user allowed
  ALLOWED_EMAILS: JSON_STR_LIST, // exact addresses, e.g. ["alice@example.com"]
  ALLOWED_EMAIL_DOMAINS: JSON_STR_LIST, // e.g. ["mycompany.com"]
  ALLOWED_LOGINS: JSON_STR_LIST, // GitHub usernames
  // JWT session lifetime in seconds — the only way to revoke access, since
  // there is no server-side session store (see auth.ts). Default 24h; NextAuth's
  // own default is 30 days, which is too long once a whole email domain is
  // admitted. Shorter = faster revocation, more frequent re-consent round trips.
  SESSION_MAX_AGE_SECONDS: z.coerce.number().int().positive().default(86_400),
  // NextAuth also reads AUTH_SECRET / AUTH_GITHUB_ID / AUTH_GITHUB_SECRET from
  // env by convention; they are surfaced here (optional) for a single typed
  // config surface and so a blank value is treated as unset. Kept optional —
  // like the reference's `oauth_github_client_id: str | None` — so the app (and
  // its signed-out sign-in page) still boots before OAuth is configured.
  AUTH_SECRET: z.preprocess(EMPTY_TO_UNDEFINED, z.string().optional()),
  AUTH_GITHUB_ID: z.preprocess(EMPTY_TO_UNDEFINED, z.string().optional()),
  AUTH_GITHUB_SECRET: z.preprocess(EMPTY_TO_UNDEFINED, z.string().optional()),

  // ── Rate limiting (Phase 4) ─────────────────────────────────────────────
  // Per-user daily query cap, counted atomically in `user_usage` (reference
  // `config.py` + `rag/usage.py`). Admins listed in ADMIN_USER_IDENTIFIERS get
  // ADMIN_DAILY_QUERY_LIMIT and (Phase 5) access to /admin. Identifiers are the
  // stable `github:<id>` keys, JSON-array like the allow-list fields.
  DAILY_QUERY_LIMIT: z.coerce.number().int().positive().default(20),
  ADMIN_DAILY_QUERY_LIMIT: z.coerce.number().int().positive().default(100000),
  ADMIN_USER_IDENTIFIERS: JSON_STR_LIST,

  // ── Global (service-wide) daily cap ─────────────────────────────────────
  // Not in the reference. DAILY_QUERY_LIMIT bounds one user; nothing bounded
  // total spend, so admitting a whole email domain multiplied the worst case by
  // the headcount. These cap the SUM across all users for the current UTC day
  // and are the backstop for a runaway bill. 0 = disabled (the default, so
  // existing single-user deploys are unaffected) — set both before widening the
  // allow-list. Admins are exempt so the owner can still diagnose a tripped cap.
  GLOBAL_DAILY_QUERY_LIMIT: z.coerce.number().int().nonnegative().default(0),
  GLOBAL_DAILY_TOKEN_LIMIT: z.coerce.number().int().nonnegative().default(0),

  // ── Admin dashboard cost estimation (Phase 5) ───────────────────────────
  // USD per million tokens, used only by /admin to estimate spend from the
  // recorded token totals (reference `config.py::llm_input/output_cost_per_million`).
  // One source of truth: usage.py's getUsageStats takes these as arguments
  // rather than owning its own constants.
  LLM_INPUT_COST_PER_MILLION: z.coerce.number().nonnegative().default(3.0),
  LLM_OUTPUT_COST_PER_MILLION: z.coerce.number().nonnegative().default(15.0),

  // ── MCP server (Phase 7) ────────────────────────────────────────────────
  // Guards /api/mcp via the x-api-key header (timing-safe compare). Optional:
  // if unset, the route logs a warning and serves UNAUTHENTICATED — mirroring
  // reference `mcp_server/server.py` (mcp_api_key: str | None). Blank → unset.
  MCP_API_KEY: z.preprocess(EMPTY_TO_UNDEFINED, z.string().optional()),

  // ── Observability — Langfuse (optional) ─────────────────────────────────
  // Tracing is enabled only when BOTH keys are set (blank → unset, same
  // pattern as MCP_API_KEY). If only one is set, boot proceeds with tracing
  // disabled and a warning — see src/mastra/observability.ts.
  LANGFUSE_PUBLIC_KEY: z.preprocess(EMPTY_TO_UNDEFINED, z.string().optional()),
  LANGFUSE_SECRET_KEY: z.preprocess(EMPTY_TO_UNDEFINED, z.string().optional()),
  LANGFUSE_BASE_URL: z.preprocess(
    EMPTY_TO_UNDEFINED,
    z.string().url().default("https://cloud.langfuse.com"),
  ),
});

export type Config = z.infer<typeof ConfigSchema>;

function loadConfig(): Config {
  const parsed = ConfigSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

export const config = loadConfig();
