import { Pool, type QueryResult } from "pg";
import { config } from "./config";

// Single shared pg Pool. Cached on globalThis so Next.js dev hot-reload does
// not leak a new pool on every module reload.
const globalForPg = globalThis as unknown as { __pgPool?: Pool };

export const pool: Pool =
  globalForPg.__pgPool ??
  new Pool({
    connectionString: config.PG_DATABASE_URL,
  });

if (!globalForPg.__pgPool) {
  globalForPg.__pgPool = pool;
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

/** True if `err` is a Postgres-side error (SQLSTATE), vs an unexpected error. */
export function isPostgresError(err: unknown): err is Error & { code?: string } {
  return (
    err instanceof Error &&
    "severity" in err &&
    "code" in err &&
    typeof (err as { code?: unknown }).code === "string"
  );
}
