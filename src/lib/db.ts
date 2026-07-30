import { Pool, type QueryResult } from "pg";
import { config } from "./config";

// Shared pg Pools, cached on globalThis so Next.js dev hot-reload does not leak
// a new pool on every module reload.
//
// There are two, on purpose:
//   `pool`      — the corpus connection. Carries the LLM-driven `query` tool, so
//                 anything its role can read is readable by any signed-in user
//                 who asks for it in SQL (validateSql bounds the statement type,
//                 not the tables).
//   `usagePool` — `user_usage` only: rate limiting and the /admin dashboard.
// Splitting them is what keeps per-user identities and token totals out of reach
// of the query tool; the grants and the rollout order live in the reference
// repo's docs/supabase-readonly-role.md (Part 2.5, `app_usage`).
const globalForPg = globalThis as unknown as { __pgPool?: Pool; __pgUsagePool?: Pool };

// Per-statement wall-clock cap for the LLM-driven `query` tool. `SET TRANSACTION
// READ ONLY` blocks writes but NOT a slow read: `SELECT pg_sleep(...)` or an
// expensive join would otherwise hang a pooled connection indefinitely, and a
// few concurrent ones exhaust the pool and take the whole app offline (the
// authoritative rate-limit count runs in the chat route's onFinish, which never
// fires for a query that never finishes). Applied per-transaction via SET LOCAL
// in runReadOnlyQuery so it scopes to tool SQL only. Env-tunable so it can be
// adjusted without a rebuild — see PG_STATEMENT_TIMEOUT_MS in config.ts.
const QUERY_STATEMENT_TIMEOUT_MS = config.PG_STATEMENT_TIMEOUT_MS;

export const pool: Pool =
  globalForPg.__pgPool ??
  new Pool({
    connectionString: config.PG_DATABASE_URL,
    // Fail fast instead of hanging when every connection is busy or the DB is
    // unreachable, rather than piling up awaiters behind an exhausted pool.
    connectionTimeoutMillis: config.PG_CONNECTION_TIMEOUT_MS,
  });

if (!globalForPg.__pgPool) {
  globalForPg.__pgPool = pool;
}

/**
 * Connection for `user_usage` reads and writes. When PG_USAGE_DATABASE_URL is
 * unset this IS `pool` — a single role does everything, which is the historical
 * behavior and leaves `user_usage` readable through the `query` tool. Point it
 * at the `app_usage` role to separate them.
 *
 * Small `max`: this pool serves two cheap statements per chat request and the
 * admin page, so it should not hold Supavisor slots the corpus pool needs.
 */
export const usagePool: Pool = config.PG_USAGE_DATABASE_URL
  ? (globalForPg.__pgUsagePool ??
    new Pool({
      connectionString: config.PG_USAGE_DATABASE_URL,
      connectionTimeoutMillis: config.PG_CONNECTION_TIMEOUT_MS,
      max: 4,
    }))
  : pool;

if (config.PG_USAGE_DATABASE_URL && !globalForPg.__pgUsagePool) {
  globalForPg.__pgUsagePool = usagePool;
}

// Loud on the combination that actually matters: a broad allow-list plus a
// single role means every admitted user can read every other user's identity
// and token totals through the query tool. Silent no-op controls are worse than
// absent ones, so say so at boot rather than leaving it to the docs.
const ACCESS_IS_BROAD = config.OPEN_REGISTRATION || config.ALLOWED_EMAIL_DOMAINS.length > 0;
if (!config.PG_USAGE_DATABASE_URL && ACCESS_IS_BROAD) {
  console.warn(
    "[db] PG_USAGE_DATABASE_URL is unset while access is open to a whole domain " +
      "(or open registration). `user_usage` — every user's github:<id> and token " +
      "totals — is readable through the agent's `query` tool. See " +
      "docs/supabase-readonly-role.md Part 2.5 in the reference repo.",
  );
}

/**
 * Execute tool SQL inside a READ ONLY transaction. This is the second of the
 * two guards on the `query` tool (the first being validateSql's SELECT-only +
 * multi-statement checks). A read-only transaction makes any write raise a
 * Postgres error instead of executing — asyncpg rejected multi-statement SQL
 * implicitly; node-postgres does not, so we defend in depth.
 */
export async function runReadOnlyQuery(sql: string): Promise<QueryResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET TRANSACTION READ ONLY");
    // Bound this statement's runtime (see QUERY_STATEMENT_TIMEOUT_MS). SET LOCAL
    // scopes it to this transaction, so it reverts when the connection returns to
    // the pool. A timeout raises a Postgres error (SQLSTATE 57014), which the
    // query tool surfaces as a "Query error: …" string rather than throwing.
    await client.query(`SET LOCAL statement_timeout = ${QUERY_STATEMENT_TIMEOUT_MS}`);
    const result = await client.query(sql);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Distinct-vulnerability count for the "Ready! N …" banner. Deliberately diverges
 * from reference `rag/vector_store.py::get_document_count`, which sums KEV + NVD
 * rows: KEV entries are CVEs that also appear in NVD, so that sum double-counts.
 * NVD is the superset corpus, so its row count is the count of distinct
 * vulnerabilities. pg returns bigint counts as strings — coerce to number.
 */
export async function getDocumentCount(): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*) AS count FROM nvd_vulnerabilities`,
  );
  return Number(result.rows[0]?.count ?? 0);
}

/** True if `err` is a Postgres-side error (SQLSTATE), vs an unexpected error. */
export function isPostgresError(err: unknown): err is Error & { code?: string } {
  return (
    err instanceof Error &&
    "severity" in err &&
    "code" in err &&
    typeof (err as { code?: unknown }).code === "string"
  );
}
