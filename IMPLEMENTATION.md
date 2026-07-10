# Implementation Plan

Phased port of the Python (Pydantic AI + Chainlit) RAG chatbot to Mastra + Next.js.
Each phase is independently shippable and ends with a commit. See `PORTING.md` for the
component map and `CLAUDE.md` for constraints; the reference implementation lives at
`../chainlit-pydanticai-postgres/` (read-only).

**Decisions locked in:**

- Phase 1 verification runs against the remote/cloud DB — `PG_DATABASE_URL` and API keys
  are supplied via `.env` (never read by tooling; `.env.example` documents the surface).
- Message history is **client-held** (React state, last `MAX_HISTORY_MESSAGES` sent per
  request). No Mastra Memory tables in the shared DB.
- The `query` tool gets **both guards**: the ported `validateSql` plus multi-statement
  rejection, and execution on a connection with `default_transaction_read_only = on`
  (asyncpg rejected multi-statement SQL implicitly; node-postgres does not).

---

## Phase 1 — MVP walking skeleton

The thinnest end-to-end vertical slice proving the Mastra RAG agent answers correctly
against the existing populated database. **Explicitly deferred to later phases: auth,
rate limiting, admin dashboard, /etl-stats, MCP, streaming, action buttons, UI polish.**

- [ ] Scaffold Next.js (App Router) + TypeScript strict + pnpm; deps: `@mastra/core`,
      `ai`, `@ai-sdk/anthropic`, `@ai-sdk/openai`, `pg`, `zod`, `vitest`
- [ ] `.gitignore` covers `.env*` (except `.env.example`), `node_modules`, `.next`
- [ ] `.env.example` (Phase-1 surface): `PG_DATABASE_URL`, `ANTHROPIC_API_KEY`,
      `OPENAI_API_KEY`; optional `TOP_K`, `EMBEDDING_MODEL`, `LLM_MODEL`, `LLM_EFFORT`,
      `SYSTEM_PROMPT`
- [ ] `src/lib/config.ts` — zod-validated env. Defaults mirror reference `config.py`:
      `TOP_K=5`, `EMBEDDING_MODEL=text-embedding-3-small` (pinned, 1536-d),
      `LLM_MODEL=claude-sonnet-5`, `LLM_EFFORT=low`, and the **system prompt ported
      verbatim** from reference `config.py` (schema doc, "query BOTH KEV and NVD" rule,
      CWE join guidance, follow-up guidance)
- [ ] `src/lib/db.ts` — single `pg` Pool from `PG_DATABASE_URL`; helper that executes
      tool SQL on a connection with `SET default_transaction_read_only = on`
- [ ] `src/lib/sql-utils.ts` — port `validate_sql`, `apply_row_limit`,
      `format_query_results` from reference `rag/sql_utils.py` (100 rows / 200 cell
      chars / 20k output chars; array cells joined by newline; truncation messages
      verbatim). Add multi-statement rejection to `validateSql`
- [ ] Vitest unit tests for sql-utils (port reference `tests/unit/test_sql_utils.py`
      cases; add multi-statement cases)
- [ ] `src/mastra/embeddings.ts` — AI SDK `embed()` with `openai.embedding(EMBEDDING_MODEL)`
- [ ] `src/mastra/tools/retrieve.ts` — embed the query, then the hand-written
      cross-table cosine search from reference `rag/vector_store.py`:
      `SELECT content FROM (… kev_vulnerabilities UNION ALL … nvd_vulnerabilities)
      ORDER BY distance LIMIT $2`, embedding passed as a `'[f1,f2,…]'` string with an
      explicit `::vector` cast. Returns `"Retrieved context:\n\n" + join("\n\n---\n\n")`
      or `"No relevant context found."`. Never re-embed the corpus
- [ ] `src/mastra/tools/query.ts` — `validateSql` → `applyRowLimit` → execute read-only
      → `formatQueryResults`. Returns error strings (`"Query error: …"`,
      `"Internal error executing query."`, `"No results found."`); never throws
- [ ] `src/mastra/agents/rag-agent.ts` — Agent with model, verbatim system prompt, both
      tools; map `LLM_EFFORT` to the Anthropic provider option
- [ ] `src/mastra/index.ts` — Mastra instance embedded in Next.js (no standalone server)
- [ ] `app/api/chat/route.ts` — non-streaming: accepts `{ messages }`, runs
      `agent.generate`, returns the final text
- [ ] `app/page.tsx` — minimal chat page: input + submit + plain transcript in React state
- [ ] **Definition of done (run it, not "it compiles"):**
  - [ ] `pnpm test` green
  - [ ] `.env` filled (by Jeff); `pnpm dev` starts
  - [ ] Conceptual question ("Tell me about Log4Shell") answered correctly via `retrieve`
  - [ ] SQL question ("How many KEV entries have known ransomware use?") answered
        correctly via `query`, cross-checked with a direct `psql` query
  - [ ] CVE-ID lookup shows the agent querying BOTH kev and nvd tables
- [ ] Commit Phase 1

## Phase 2 — Chat experience (streaming, history, action buttons)

- [x] Streaming chat route (agent stream → AI SDK UI message stream)
- [x] Real chat UI: `useChat`, markdown rendering, visible tool-call steps
- [x] Client-held history trimmed to `MAX_HISTORY_MESSAGES` (default 50)
- [x] "Ready! N vulnerability records available." banner (port `get_document_count`)
- [x] `ACTION_BUTTONS` quick-query buttons; introduce the JSON-array env convention with
      blank-tolerant parsing (`""` → `[]`, port of `_decode_json_list`)
- [x] Config additions: `MAX_HISTORY_MESSAGES`, `ACTION_BUTTONS`; update `.env.example`
      (both were already documented in `.env.example` from Phase 1)
- [x] Verify: streamed answer renders; follow-up resolves references ("what CVSS score
      does it have?")
- [x] Commit Phase 2

## Phase 3 — Auth (NextAuth GitHub + allow-list)

- [x] `auth.ts` — NextAuth v5, GitHub provider; `signIn` callback ports the reference
      `app.py::oauth_callback` branching exactly: allow if `OPEN_REGISTRATION` → email in
      `ALLOWED_EMAILS` → email domain in `ALLOWED_EMAIL_DOMAINS` → login in
      `ALLOWED_LOGINS`; else deny + log warning (branching lives in the pure,
      unit-tested `src/lib/auth-allowlist.ts::decideAccess`)
- [x] Identity key = stable numeric GitHub id as `github:<id>` (never login/email),
      carried in JWT/session
- [x] Gate the chat page and `/api/chat` (401 without session); sign-in / denied UX
- [x] Config additions: `AUTH_SECRET`, `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET`,
      `ALLOWED_EMAILS`, `ALLOWED_EMAIL_DOMAINS`, `ALLOWED_LOGINS`, `OPEN_REGISTRATION`
      (`.env.example` already documented these from Phase 1; `AUTH_*` kept optional in
      `config.ts` — NextAuth reads them from env directly — so boot never hard-fails
      before OAuth is configured)
- [x] Unit tests for the allow-list decision function (port `test_oauth_callback.py`)
- [ ] Verify: real GitHub sign-in succeeds when allow-listed; denied when not
      (pending Jeff's manual test — needs a GitHub OAuth App + `AUTH_*` secrets in `.env`)
- [x] Commit Phase 3

## Phase 4 — Rate limiting + token accounting

- [ ] `src/lib/usage.ts` — `checkAndIncrement`: the exact atomic upsert from reference
      `rag/usage.py` (`INSERT … ON CONFLICT (user_identifier, query_date) DO UPDATE …
      RETURNING query_count`); `allowed = new_count <= limit`
- [ ] `limitFor(userId)` — `ADMIN_DAILY_QUERY_LIMIT` for `ADMIN_USER_IDENTIFIERS`
      members, else `DAILY_QUERY_LIMIT`
- [ ] Wrap `/api/chat`: cheap read-only pre-check before the LLM call; authoritative
      `checkAndIncrement` after, with input/output tokens from the run result; withhold
      the answer on the TOCTOU over-limit case. Message verbatim: "You've reached your
      daily limit of {limit} queries. Try again tomorrow."
- [ ] Config additions: `DAILY_QUERY_LIMIT` (20), `ADMIN_DAILY_QUERY_LIMIT` (100000),
      `ADMIN_USER_IDENTIFIERS`
- [ ] Tests: port `test_rate_limit.py` boundary semantics
- [ ] Verify live with `DAILY_QUERY_LIMIT=2`: third query blocked; `user_usage` row shows
      counts + tokens. **Prereq:** the app DB role needs INSERT/UPDATE on `user_usage`
      (+ its id sequence) — confirm on the remote DB first
- [ ] Commit Phase 4

## Phase 5 — Admin usage dashboard

- [ ] `/admin` server component, **session-gated to `ADMIN_USER_IDENTIFIERS`**
      (HTTP Basic / `ADMIN_SECRET` dropped by design)
- [ ] Port `get_usage_stats` (today/7d/30d query counts, all-time tokens, estimated cost
      from `LLM_INPUT_COST_PER_MILLION` / `LLM_OUTPUT_COST_PER_MILLION`)
- [ ] Config additions: cost-per-million vars; update `.env.example`
- [ ] Verify: admin sees real rows; non-admin and signed-out are denied
- [ ] Commit Phase 5

## Phase 6 — Public /etl-stats page

- [ ] `/etl-stats` server component reading `etl_runs` (newest first, LIMIT 50), no auth
- [ ] Port the public-exposure hardening from reference `rag/etl_stats.py`: **never
      render the raw per-loader `error` field** — status, counts, durations, and a
      generic "failed" only
- [ ] Verify: renders real ETL run rows from the shared DB
- [ ] Commit Phase 6

## Phase 7 — MCP server route

- [ ] `app/api/mcp/route.ts` — `@mastra/mcp` `MCPServer` (streamable-http) exposing the
      **same** `query` + `retrieve` tool implementations (reuse, don't duplicate)
- [ ] `x-api-key` check with timing-safe compare against `MCP_API_KEY`; log a warning if
      unset (endpoint would be unauthenticated)
- [ ] Config addition: `MCP_API_KEY`
- [ ] Verify: connect with an MCP client and call both tools; wrong key → 401
- [ ] Commit Phase 7

## Phase 8 — Infra polish (optional)

- [ ] Dockerfile (Node), README refresh, lint config
- [ ] Commit Phase 8

---

## Porting hazards (flagged; resolutions chosen)

1. **Multi-statement SQL** — node-postgres's simple query protocol allows
   `SELECT 1; DELETE …`; asyncpg did not. Resolved with both guards (see decisions).
   This is the only deliberate deviation from the reference validator.
2. **`apply_row_limit` first-LIMIT quirk** — the reference regex caps the *first*
   `LIMIT n` it finds (a subquery LIMIT gets capped; the outer query gets none
   appended). Ported bug-for-bug for parity.
3. **`validate_sql` rejects CTEs** — `WITH … SELECT` fails "starts with SELECT" in the
   reference too. Ported as-is.
4. **Vector parameter encoding** — asyncpg used a registered pgvector codec;
   node-postgres needs `'[f1,f2,…]'` + `::vector` cast. Covered by Phase 1 DoD.
5. **`LLM_EFFORT` mapping** — reference sets Anthropic `effort="low"` for latency. Map
   to the AI SDK Anthropic provider option; if the installed SDK version doesn't support
   it, omit it and note the latency tradeoff rather than substituting.
6. **Token accounting drift** — the AI SDK and pydantic-ai may count cached/thinking
   tokens differently. Query *counts* (the gate) are exact; token totals are
   cost-estimate-grade. Acceptable.
7. **`user_usage` write grants** — the app is otherwise read-only but needs
   INSERT/UPDATE on `user_usage`; DDL stays owned by the Python ETL side.

## Verification approach (every phase)

Run the real app against the real remote DB (`pnpm dev`), exercise the new capability
end-to-end, and cross-check data answers with direct `psql` queries. `pnpm test` green
before each commit. No phase is done on compilation alone.
