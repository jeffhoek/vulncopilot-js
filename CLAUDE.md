# CLAUDE.md

A RAG chatbot over CISA KEV + NIST NVD vulnerability data, built with **Mastra**
(TypeScript) and a **custom Next.js** frontend. It reads a PostgreSQL/pgvector database
populated by a separate Python ETL pipeline (the reference repo — see below).

This is a **port** of an existing, working Python app (Pydantic AI + Chainlit). The RAG
design and database schema are already proven — reuse them; don't redesign.

## Reference implementation (read-only)

The original Python app is checked out as a **sibling directory**:
`../chainlit-pydanticai-postgres/`. **Read it, never modify it.** When building a piece,
read its counterpart first:

| Building… | Read |
|---|---|
| Agent + tools | `../chainlit-pydanticai-postgres/rag/agent.py` |
| SQL validation / row-limit guards | `../chainlit-pydanticai-postgres/rag/sql_utils.py` |
| Vector search (cross-table UNION) | `../chainlit-pydanticai-postgres/rag/vector_store.py` |
| DB schema (source of truth) | `../chainlit-pydanticai-postgres/rag/database.py` |
| Embeddings | `../chainlit-pydanticai-postgres/rag/embeddings.py` |
| Auth + rate-limit wiring | `../chainlit-pydanticai-postgres/app.py` |
| Rate-limit upsert | `../chainlit-pydanticai-postgres/rag/usage.py` |
| MCP tools | `../chainlit-pydanticai-postgres/mcp_server/server.py` |
| Config surface + system prompt | `../chainlit-pydanticai-postgres/config.py` |

Full migration plan: `PORTING.md` in this repo.

## Stack (decided — do not re-litigate)

- **Mastra** for agent/tools/RAG/MCP.
- **Vercel AI SDK** for model + embedding providers (`@ai-sdk/anthropic`, `@ai-sdk/openai`).
- **`@mastra/pg`** for pgvector access (but see "Vector search" caveat).
- **Next.js (App Router)** frontend + API routes; Mastra runs **inside** Next.js API routes
  (single deployable). No standalone Mastra server.
- **NextAuth.js (Auth.js)** — GitHub provider — for OAuth + allow-list gating.
- **Vitest** for tests. **pnpm** for packages. TypeScript strict.
- Postgres + pgvector: **reuse the existing database.** This app is **read-mostly** and
  does **not** own schema DDL (the Python ETL side does). Only `user_usage` is written.

## Data contract (must not drift from the reference repo)

- Embeddings: **`text-embedding-3-small`, 1536 dimensions.** Pin it. A mismatch silently
  breaks cosine search.
- Tables: `kev_vulnerabilities`, `nvd_vulnerabilities` (each `content TEXT`,
  `embedding vector(1536)`, HNSW `vector_cosine_ops`), `cwe_definitions`, `etl_runs`,
  `user_usage`. DDL: reference repo `rag/database.py`.
- Port the **system prompt verbatim** from reference `config.py` (it describes the schema
  the SQL tool depends on, the "query BOTH KEV and NVD for a CVE" rule, and CWE joins).
- Do **not** re-embed the corpus — vectors already exist in the DB.

## The two agent tools (parity targets)

1. **`query(sql)`** — read-only SQL. Must call `validateSql` then `applyRowLimit` before
   executing (port both from reference `sql_utils.py`). Return a formatted table or an
   error string; never throw to the model.
2. **`retrieve(query)`** — semantic search. Embed the query via AI SDK, then run the
   **cross-table `UNION ALL` cosine query** over both vuln tables (reference
   `vector_store.py`). Prefer hand-written SQL over the `PgVector` query API for this UNION.

## Rate limiting (preserve exact semantics)

Per-user daily limit with token accounting. Authoritative gate is an atomic
`INSERT … ON CONFLICT (user_identifier, query_date) DO UPDATE … RETURNING query_count`;
`allowed = new_count <= limit` (reference `usage.py`). Wrap the chat route: cheap pre-check
before the LLM call, authoritative count after. Admins in `ADMIN_USER_IDENTIFIERS` get
`ADMIN_DAILY_QUERY_LIMIT`.

## Auth allow-list (port the branching from reference `app.py::oauth_callback`)

Allow if: `OPEN_REGISTRATION` true; OR email in `ALLOWED_EMAILS`; OR email domain in
`ALLOWED_EMAIL_DOMAINS`; OR GitHub login in `ALLOWED_LOGINS`. Else deny. Use the **stable
numeric GitHub id** (`github:<id>`) as the identity key, not the mutable login/email.

## Config

Typed `config.ts` (zod-validated env). List env vars use the JSON-array convention
(`ALLOWED_EMAILS=["a@x.com"]`). Carry over the vars in `PORTING.md` §6. `ADMIN_SECRET`
(old HTTP Basic) is dropped — the admin page is session-gated to `ADMIN_USER_IDENTIFIERS`.

## Secrets

- NEVER commit secrets. `.env` is gitignored; only `.env.example` is checked in.
- Never read `.env`; read `.env.example`.

## Commands

```bash
pnpm install
pnpm dev          # Next.js dev server (Mastra embedded)
pnpm test         # Vitest
pnpm build
```

## Scope boundary

Do **not** port the ETL scripts (`scripts/*`, KEV/NVD/CWE loaders) — they stay in the
Python repo and keep populating the shared database. This repo is the app only.
