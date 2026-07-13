# KEV/NVD RAG Chatbot (Mastra)

A retrieval-augmented chatbot for natural-language queries over the **CISA Known Exploited
Vulnerabilities (KEV)** catalog and the **NIST National Vulnerability Database (NVD)**. Built
with [Mastra](https://mastra.ai) and Next.js; answers questions via semantic search
(pgvector) and read-only SQL over a PostgreSQL database.

Ask things like *"tell me about Log4Shell"*, *"list KEV entries with known ransomware use"*,
or *"top 10 AI-related CVEs in 2026 by CVSS score"*.

> This is a TypeScript port of a Python (Pydantic AI + Chainlit) implementation. See
> [`PORTING.md`](./PORTING.md) for the migration plan and the design it inherits.

## Architecture

```
Next.js (App Router)
├── chat UI            streaming answers, quick-query buttons, GitHub sign-in
├── /admin             per-user usage + estimated cost (admins only)
├── /etl-stats         public ETL run history
├── /api/chat          → Mastra RAG agent
└── /api/mcp           → Mastra MCP server (x-api-key)
        │
   Mastra agent ── tools: retrieve (semantic search), query (read-only SQL)
        │
   PostgreSQL + pgvector   ◄── populated by a separate Python ETL pipeline
```

The agent has two tools:

- **retrieve** — semantic search across KEV + NVD via pgvector cosine similarity. Best for
  conceptual questions.
- **query** — executes validated, read-only `SELECT` statements. Best for counts, top-N,
  filters, grouping, and JOINs across KEV, NVD, and CWE tables.

Model routing uses the Vercel AI SDK (Anthropic Claude for generation, OpenAI
`text-embedding-3-small` for embeddings).

## The database is shared and externally populated

This app is **read-mostly**. It does **not** create or load the schema — a separate
**Python ETL pipeline** (the reference repo) ingests KEV/NVD/CWE data and writes the
vectors. This app connects to that same database and reads it.

- **Embeddings are pinned** to `text-embedding-3-small` (1536-d). Changing the embedding
  model without re-embedding the corpus silently breaks search.
- The only table this app writes is `user_usage` (rate limiting).
- Schema source of truth lives on the ETL side (`rag/database.py` in the reference repo).

You need a populated database before this app is useful. Point `PG_DATABASE_URL` at the
database the ETL pipeline maintains.

## Getting started

Prerequisites: **Node 20+**, **pnpm**, and access to a populated Postgres+pgvector database.

```bash
pnpm install
cp .env.example .env.local     # then fill in keys + PG_DATABASE_URL
pnpm dev                       # http://localhost:3000
```

Minimum required env: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `PG_DATABASE_URL`,
`AUTH_SECRET`, and GitHub OAuth (`AUTH_GITHUB_ID` / `AUTH_GITHUB_SECRET`). See
[`.env.example`](./.env.example) for the full surface. Note: list-valued env vars are
**JSON arrays**, not comma-separated.

## Access control

Sign-in is GitHub OAuth. Access is allow-listed — a user is admitted if `OPEN_REGISTRATION`
is true, or their email / email domain / GitHub login matches the `ALLOWED_*` lists.
Identity is keyed on the stable GitHub numeric id (`github:<id>`), not the mutable
username or email.

## Rate limiting

Each user gets `DAILY_QUERY_LIMIT` queries per UTC day, tracked in `user_usage` with token
accounting. Users listed in `ADMIN_USER_IDENTIFIERS` get `ADMIN_DAILY_QUERY_LIMIT` and can
view the `/admin` usage dashboard.

## MCP server

`/api/mcp` exposes the same `retrieve` and `query` tools over MCP (streamable-http),
guarded by the `x-api-key` header (`MCP_API_KEY`). Leaving `MCP_API_KEY` unset makes the
endpoint unauthenticated — set it before deploying.

## Scripts

```bash
pnpm dev      # dev server
pnpm build    # production build (emits the standalone server bundle)
pnpm start    # run the production build
pnpm test     # Vitest
pnpm lint     # ESLint (next/core-web-vitals + next/typescript)
```

## Docker

The app builds into a self-contained image (Next.js `output: "standalone"`, non-root
runtime user). No database or secrets are baked in — they're supplied at run time.

```bash
podman build -t vulncopilot .          # or: docker build -t vulncopilot .
podman run --rm -p 3000:3000 --env-file docker.env -e AUTH_TRUST_HOST=true vulncopilot
```

The build uses throwaway placeholder values for the required env vars (config is
validated at import, which Next triggers during build-time page-data collection); real
values come from `--env-file` / your orchestrator at run time.

Deploy-time env notes:

- **`--env-file` is NOT dotenv.** docker/podman pass each line verbatim — they do **not**
  strip inline `# comments` or surrounding quotes the way Next's `.env` loader does. So a
  Next-style line like `ALLOWED_LOGINS=["a"]  # note` reaches the app as the literal
  string `["a"]  # note` and fails JSON-array parsing. For containers, keep a separate
  `docker.env` with **bare** `KEY=VALUE` lines (no inline comments, no quotes); the
  JSON-array convention still works as long as the value is bare (`ALLOWED_LOGINS=["a"]`).
- **`AUTH_TRUST_HOST=true` is required** when self-hosting behind a proxy (anything other
  than Vercel). Without it NextAuth rejects requests with `UntrustedHost` and sign-in
  breaks. `pnpm dev` auto-trusts localhost, so this only bites in the container.
- Set `AUTH_URL` to the app's public origin and `MCP_API_KEY` before exposing the app.
- The image listens on `PORT` (default 3000) and binds `0.0.0.0`.

## Project layout

```
app/            Next.js App Router routes (chat UI, /admin, /etl-stats, api/chat, api/auth)
pages/api/      Pages Router — api/mcp.ts (needs native Node req/res; see IMPLEMENTATION.md)
auth.ts         NextAuth (GitHub provider + allow-list gate)
src/mastra/     Mastra instance, agent, tools, vector access
  agents/       RAG agent (model + system prompt + tools)
  tools/        query.ts (SQL) · retrieve.ts (semantic search)
src/lib/        config (zod env), auth allow-list, rate limiting, sql guards, db pool
Dockerfile      Multi-stage build → standalone, non-root runtime image
```

## Related

- Migration plan and reference-implementation map: [`PORTING.md`](./PORTING.md)
- Reference implementation (Python): the sibling `vulncopilot` repo, which
  also owns the ETL pipeline that populates the database.
