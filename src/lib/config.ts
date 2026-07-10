import { z } from "zod";

// Typed, zod-validated env surface. Defaults mirror the reference `config.py`.
// This module fails fast at import if required vars are missing — it is only
// imported by server-side code (DB, tools, agent), never by the pure sql-utils
// unit tests, so `pnpm test` does not require a filled `.env`.

// The system prompt is ported VERBATIM from reference `config.py::system_prompt`.
// It documents the schema the SQL tool depends on, the "query BOTH KEV and NVD
// for a CVE" rule, the CWE join guidance, and follow-up guidance. Do not edit
// without matching the reference (the SQL tool's correctness depends on it).
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
  raw_json JSONB -- full NVD API response, query with -> and ->> operators
)

TABLE: cwe_definitions (
  cwe_id VARCHAR(20),       -- e.g., 'CWE-79'
  name TEXT,                -- human-readable weakness name
  abstraction VARCHAR(20),  -- Pillar, Class, Base, Variant, Compound
  description TEXT,
  url TEXT
)

JOIN tables on cve_id to cross-reference KEV and NVD data.
JOIN cwe_definitions using: cwe_id = ANY(nvd_vulnerabilities.cwes) or cwe_id = ANY(kev_vulnerabilities.cwes) to resolve CWE IDs to names.

## Tools

- **retrieve**: semantic search across both datasets. Use for conceptual questions (e.g. 'tell me about Log4j').
- **query**: execute SQL. Use for counts, top-N, date filters, grouping, listing, JOINs across tables, and specific CVE ID lookups. For CVE ID lookups, always query BOTH kev_vulnerabilities AND nvd_vulnerabilities before concluding a CVE is not found — a CVE may exist in NVD without appearing in KEV.

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
  OPEN_REGISTRATION: BOOL, // true = any GitHub user allowed
  ALLOWED_EMAILS: JSON_STR_LIST, // exact addresses, e.g. ["alice@example.com"]
  ALLOWED_EMAIL_DOMAINS: JSON_STR_LIST, // e.g. ["mycompany.com"]
  ALLOWED_LOGINS: JSON_STR_LIST, // GitHub usernames
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

  // ── Admin dashboard cost estimation (Phase 5) ───────────────────────────
  // USD per million tokens, used only by /admin to estimate spend from the
  // recorded token totals (reference `config.py::llm_input/output_cost_per_million`).
  // One source of truth: usage.py's getUsageStats takes these as arguments
  // rather than owning its own constants.
  LLM_INPUT_COST_PER_MILLION: z.coerce.number().nonnegative().default(3.0),
  LLM_OUTPUT_COST_PER_MILLION: z.coerce.number().nonnegative().default(15.0),
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
