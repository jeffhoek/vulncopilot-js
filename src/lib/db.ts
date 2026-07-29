import { Pool, type QueryResult } from "pg";
import { config } from "./config";

// Single shared pg Pool. Cached on globalThis so Next.js dev hot-reload does
// not leak a new pool on every module reload.
const globalForPg = globalThis as unknown as { __pgPool?: Pool };

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

/**
 * Startup guard for the LLM SQL-tool risk: the `query` tool runs LLM-generated
 * SELECTs, and the real containment is the privilege of the role in
 * PG_DATABASE_URL. A superuser (or a role in `pg_read_server_files`) can turn a
 * SELECT into a host-file read or SSRF primitive despite the READ ONLY
 * transaction. The intended role is the scoped `app_readonly` (see the reference
 * repo's docs/supabase-readonly-role.md). Warn loudly at boot if we connected as
 * a superuser so a misconfigured deploy is obvious. Best-effort and non-fatal —
 * a transient DB hiccup must not block startup.
 */
async function assertLeastPrivilegeRole(p: Pool): Promise<void> {
  try {
    const res = await p.query<{ is_superuser: string }>(
      "SELECT current_setting('is_superuser') AS is_superuser",
    );
    if (res.rows[0]?.is_superuser === "on") {
      console.error(
        "SECURITY: connected to Postgres as a SUPERUSER. The `query` tool runs " +
          "LLM-generated SQL; a superuser role makes SELECT a host-file-read / SSRF " +
          "primitive. Use a least-privileged read-only role — see the reference " +
          "repo's docs/supabase-readonly-role.md (the `app_readonly` role).",
      );
    }
  } catch {
    // DB unreachable at boot; skip the check (non-fatal).
  }
}

if (!globalForPg.__pgPool) {
  globalForPg.__pgPool = pool;
  // Fire-and-forget; runs once per fresh pool (not on every hot-reload).
  void assertLeastPrivilegeRole(pool);
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
