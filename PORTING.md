# Porting `rag-chatbot` → Mastra.ai

Migration plan for re-implementing the CISA KEV / NIST NVD RAG chatbot on
[Mastra](https://mastra.ai) (TypeScript) with a custom Next.js frontend.

> **Status:** planning. This document is the human-facing plan. The machine-facing
> bootstrap for the new repo lives in [`CLAUDE.md`](./CLAUDE.md) (copy it to the new
> repo root).

---

## 1. Decision summary

| Decision | Choice | Rationale |
|---|---|---|
| Framework | Mastra (TS) | Agent + tools + RAG + MCP primitives map ~1:1 to the current Pydantic AI design |
| Model routing | Vercel AI SDK (`@ai-sdk/anthropic`, `@ai-sdk/openai`) | Mastra's native provider layer; Claude is first-class |
| Vector store | `@mastra/pg` `PgVector` | Native pgvector support — reuse the **existing** database and schema unchanged |
| Frontend | **Custom Next.js (App Router)** | Full control over chat UX, auth flows, action buttons, admin/ETL pages that Chainlit gave for free |
| Auth | NextAuth.js (Auth.js) — GitHub provider | Replaces Chainlit `oauth_callback` + allow-list gating |
| MCP | `@mastra/mcp` `MCPServer` | Re-expose the same `query` + `retrieve` tools over streamable-http |
| ETL / data loading | **Stays in Python, in the current repo** | KEV/NVD/CWE loaders are large and stable; the new app is read-mostly against the same DB |
| Deploy | Single Next.js app (Mastra embedded in API routes) | Matches today's single-container model; one deployable |

**Guiding principle:** this is a rebuild of the *Chainlit layer*, not the *RAG engine*.
The RAG engine and database are the easy part. The database is the moat and does not move.

---

## 2. Architecture: today vs. target

**Today (this repo):** Chainlit SPA → FastAPI (Chainlit-owned) → Pydantic AI agent →
asyncpg pool → Postgres/pgvector. FastMCP server mounted via ASGI middleware. ETL scripts
write the same DB.

**Target (new repo):**

```
Next.js App Router
├── app/(chat)/…            custom chat UI (streaming, action buttons, history)
├── app/admin/…             usage dashboard (was /admin, HTTP Basic → session-gated)
├── app/etl-stats/…         public ETL run-history page
├── app/api/chat/route.ts   → Mastra agent (streamText)
├── app/api/mcp/route.ts    → Mastra MCPServer (x-api-key auth)
├── auth.ts                 NextAuth (GitHub) + allow-list callback
└── src/mastra/
    ├── index.ts            Mastra instance
    ├── agents/rag-agent.ts Agent(model, system prompt, tools)
    ├── tools/query.ts      SQL tool (validateSql + applyRowLimit)
    ├── tools/retrieve.ts   semantic search (PgVector)
    └── vector.ts           PgVector + embed()
                    │
                    ▼
        Postgres + pgvector  ◄── ETL scripts (Python, stays in old repo)
```

Both apps share one database. The **schema is authored by the Python ETL side**
(`rag/database.py::SCHEMA_SQL`); the Mastra app connects with a **read-mostly** role and
does **not** own DDL (mirrors today's `DB_INIT_SCHEMA=false` read-only-role setup). The
one exception is `user_usage`, which the app writes on every query — decide whether the
app or a migration owns that table (recommend: a shared migration, app has INSERT/UPDATE).

---

## 3. Component-by-component map

### 3a. Maps cleanly (low effort)

| Today | File | Mastra target |
|---|---|---|
| `rag_agent` + system prompt + Anthropic effort | `rag/agent.py`, `config.py` | `new Agent({ model: anthropic('claude-sonnet-5'), instructions, tools })`; effort → provider options |
| `query` tool (SQL) | `rag/agent.py:29` | `createTool({ inputSchema: z.object({ sql }), execute })` |
| `retrieve` tool (semantic) | `rag/agent.py:60` | `createTool` calling PgVector query |
| `validate_sql` / `apply_row_limit` / `format_query_results` | `rag/sql_utils.py` | Direct TS port — pure functions, no framework |
| `PgVectorStore.search` (UNION KEV+NVD, cosine) | `rag/vector_store.py` | `PgVector` — but see note ⚠️ below |
| `generate_embedding` (OpenAI `text-embedding-3-small`, 1536-d) | `rag/embeddings.py` | AI SDK `embed({ model: openai.embedding('text-embedding-3-small') })` |
| MCP `query` + `retrieve` tools + x-api-key auth | `mcp_server/server.py` | `MCPServer({ tools })` behind an API route that checks `x-api-key` |
| Per-session `message_history` (last 50) | `app.py` | Mastra `Memory` (Postgres thread store) or client-managed history |
| Config surface (`Settings`) | `config.py` | env + a typed `config.ts` (zod) — see §6 |

⚠️ **Vector store nuance.** The current search is a single query `UNION ALL` across
`kev_vulnerabilities` **and** `nvd_vulnerabilities`, both with `vector(1536)` +
HNSW `vector_cosine_ops` (`rag/vector_store.py`, `rag/database.py`). Mastra's `PgVector`
abstraction is index-per-"index-name" and may not express a cross-table UNION cleanly.
**Recommendation:** keep the hand-written SQL for `retrieve` (use `PgVector`'s raw
connection or a plain `pg` pool) rather than forcing it through the `PgVector` query API.
Embedding generation still goes through the AI SDK. Don't re-embed the corpus — the
vectors already exist in the DB from the Python ETL.

### 3b. Must be rebuilt (the real cost — no Chainlit equivalent)

| Capability | Today | Target |
|---|---|---|
| Chat UI (streaming, markdown, action buttons, "Ready! N records") | Chainlit SPA | Custom Next.js: AI SDK `useChat` + streaming route |
| Quick-query action buttons | `cl.Action` / `action_callback` | React buttons that submit `settings.action_buttons` prompts |
| GitHub OAuth + allow-list (email / domain / login, `open_registration`) | `app.py:91` `oauth_callback` | NextAuth `signIn` callback replicating the same allow/deny logic |
| Per-user daily rate limit + token accounting (atomic upsert) | `rag/usage.py`, `app.py` `enforce_daily_limit`/`record_usage` | Port `check_and_increment` upsert; wrap the chat route (pre-check + authoritative post-count) |
| Admin usage dashboard (`/admin`, HTTP Basic) | `admin/dashboard.py`, `rag/usage.py::get_usage_stats` | Next.js `/admin` route, session-gated to `admin_user_identifiers` (drop Basic Auth) |
| Public ETL run-history (`/etl-stats`) | `app.py:43`, `rag/etl_stats.py` | Next.js server component reading `etl_runs` |
| MCP ASGI middleware + concurrent lifespan | `mcp_server/server.py` `McpRouterMiddleware` | Gone — MCP is just a Next.js API route now (much simpler) |

### 3c. Stays in Python (does not port)

- `scripts/load_kev.py`, `load_nvd.py`, `load_nvd_full.py`, `load_cwe.py`, `run_etl.py`,
  `nvd_utils.py`, `refresh_egress_ips.py` — the ETL pipeline (NVD API, backoff, batching).
- `rag/database.py::SCHEMA_SQL` — **remains the single source of truth for the schema.**
- `rag/etl_stats.py` write path (the read path is reimplemented in the app).

The Python repo keeps running the loaders on its existing schedule; the Mastra app just
reads what they produce.

---

## 4. Data contract (must not drift)

The two repos are coupled through the database. Lock these:

- **Embedding model:** `text-embedding-3-small`, **1536 dimensions**. If the app ever
  re-embeds a query with a different model, cosine search silently degrades. Pin it.
- **Tables:** `kev_vulnerabilities`, `nvd_vulnerabilities` (both `content TEXT`,
  `embedding vector(1536)`, HNSW cosine index), `cwe_definitions`, `etl_runs`,
  `user_usage`. Full DDL: `rag/database.py`.
- **System prompt** carries the schema description the LLM relies on for its SQL tool
  (`config.py::system_prompt`). Port it verbatim, including the "query BOTH tables for a
  CVE" instruction and the CWE join guidance.
- **`user_usage` upsert semantics:** atomic `INSERT … ON CONFLICT … DO UPDATE RETURNING
  query_count`; `allowed = new_count <= limit` (`rag/usage.py`). Preserve exactly — it's
  the authoritative rate-limit gate under concurrency.

---

## 5. Effort & sequencing

Rough relative sizing (S/M/L), assuming ETL stays in Python:

1. **S** — Scaffold Mastra + Next.js; wire DB connection (read-mostly role); config.ts.
2. **S** — Port `sql_utils` (pure functions) + unit tests (Vitest).
3. **S** — `retrieve` tool (raw SQL UNION + AI SDK embed) + `query` tool.
4. **S** — Agent (model, system prompt, effort, tools). Verify parity against this repo.
5. **M** — Chat UI: streaming route + custom React chat + action buttons + history.
6. **M** — Auth: NextAuth GitHub + allow-list callback + session.
7. **M** — Rate limiting: port upsert, wrap chat route, admin-elevated limits.
8. **S** — Admin dashboard + `/etl-stats` (read-only server components).
9. **S** — MCP route (`MCPServer` + x-api-key). Simpler than today's ASGI middleware.
10. **S** — Infra: Dockerfile (Node), compose/k8s/bicep mostly reusable.

**The critical path and the bulk of the work is 5–7** (UI + auth + rate limiting) — the
things Chainlit gave for free. 1–4 and 9 are the "easy" RAG core.

## 6. Config translation

`config.py::Settings` → typed `config.ts` (zod-validated env). Carry over: `PG_DATABASE_URL`,
`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `TOP_K`, `MAX_HISTORY_MESSAGES`, `EMBEDDING_MODEL`,
`LLM_MODEL`, `LLM_EFFORT`, `SYSTEM_PROMPT`, OAuth client id/secret, `ALLOWED_EMAIL_DOMAINS`,
`ALLOWED_EMAILS`, `ALLOWED_LOGINS`, `OPEN_REGISTRATION`, `DAILY_QUERY_LIMIT`,
`ADMIN_DAILY_QUERY_LIMIT`, `ADMIN_USER_IDENTIFIERS`, `MCP_API_KEY`, `ACTION_BUTTONS`,
`LLM_INPUT/OUTPUT_COST_PER_MILLION`. Note the JSON-array env convention (`ALLOWED_EMAILS=["a@x.com"]`).
`ADMIN_SECRET` (HTTP Basic) is dropped — admin is session-gated instead.

## 7. Open questions / risks

- **`user_usage` ownership:** shared migration vs. app-owned. Recommend a migration both
  repos agree on; app gets INSERT/UPDATE, everything else read-only.
- **Message history store:** Mastra `Memory` (server threads in Postgres) vs. client-held
  history. Threads add a table but give durable, per-user history; today it's in-session only.
- **Streaming parity:** confirm AI SDK streaming + tool-call display matches the Chainlit
  UX users expect (intermediate tool steps, final markdown answer).
- **Provider effort flag:** map `LLM_EFFORT=low` to the AI SDK Anthropic provider option
  and verify latency behavior matches (`config.py:56` explains why it's set to `low`).

## 8. Reference implementation

Keep this repo checked out as a **sibling directory** and read-only reference. Highest-value
files to read when building each piece:

- Agent + tools: `rag/agent.py`
- SQL guards: `rag/sql_utils.py`
- Vector search (the UNION query): `rag/vector_store.py`, schema in `rag/database.py`
- Embeddings: `rag/embeddings.py`
- Auth + rate-limit wiring: `app.py`
- Rate-limit upsert: `rag/usage.py`
- MCP tools: `mcp_server/server.py`
- Config surface + system prompt: `config.py`
