// Ported from the reference Python app: `rag/sql_utils.py`.
// Keep behavior at parity with the reference (including the deliberately-ported
// first-LIMIT quirk in applyRowLimit); the only intentional deviation is the
// multi-statement rejection added to validateSql — asyncpg rejected
// `SELECT 1; DELETE ...` implicitly, node-postgres does not (see IMPLEMENTATION.md).

export const MAX_QUERY_ROWS = 100;
export const MAX_CELL_CHARS = 200;
export const MAX_OUTPUT_CHARS = 20_000;

// Defense-in-depth denylist (added guard, beyond the reference). `SET TRANSACTION
// READ ONLY` blocks writes but not reads, so a valid SELECT can still invoke
// server-side functions that touch the host filesystem, large objects, or the
// network (SSRF). The AUTHORITATIVE control is the least-privileged Postgres role
// the app connects as (the `app_readonly` role — see the reference repo's
// docs/supabase-readonly-role.md), which lacks the privileges these functions
// need. This list is a second layer that fails such a query with a clear message
// before it ever reaches the DB.
//
// Scoped to FUNCTION-CALL syntax (`name(`) on purpose: this is a vulnerability
// database, so legitimate text searches like `WHERE description ILIKE
// '%pg_read_file%'` must still work — those are string literals, not calls, so
// they don't match. Credential catalogs (pg_authid/pg_shadow) are intentionally
// NOT listed here: a non-superuser role cannot read them, and listing them would
// break legitimate text searches; the role is the control for those.
const BLOCKED_FUNCTIONS = [
  "pg_read_file",
  "pg_read_binary_file",
  "pg_stat_file",
  "pg_ls_dir",
  "pg_ls_logdir",
  "pg_ls_waldir",
  "pg_ls_tmpdir",
  "lo_import",
  "lo_export",
  "dblink",
  "dblink_exec",
  "dblink_connect",
];
// Matches an optionally schema-qualified call to any blocked function, e.g.
// `pg_read_file(`, `pg_catalog.pg_read_file (`. Case-insensitive.
const BLOCKED_FUNCTION_RE = new RegExp(
  `\\b(?:${BLOCKED_FUNCTIONS.join("|")})\\s*\\(`,
  "i",
);

/** Return an error string if sql is not a single safe SELECT statement, else null. */
export function validateSql(sql: string): string | null {
  const trimmed = sql.trim();
  if (!trimmed.toUpperCase().startsWith("SELECT")) {
    return "Error: Only SELECT statements are permitted.";
  }
  // Multi-statement rejection (added guard). node-postgres's simple query
  // protocol would happily run `SELECT 1; DELETE FROM t`. Allow a single
  // trailing semicolon; reject any other `;`.
  const withoutTrailing = trimmed.replace(/;\s*$/, "");
  if (withoutTrailing.includes(";")) {
    return "Error: Only a single SQL statement is permitted.";
  }
  // Block file/large-object/network function calls (see BLOCKED_FUNCTIONS).
  if (BLOCKED_FUNCTION_RE.test(trimmed)) {
    return "Error: This query uses a disallowed function.";
  }
  return null;
}

/** Cap or inject a LIMIT clause, returning the rewritten SQL. */
export function applyRowLimit(sql: string, maxRows: number = MAX_QUERY_ROWS): string {
  const match = /\bLIMIT\s+(\d+)\b/i.exec(sql);
  if (match) {
    // Ported bug-for-bug: only the FIRST LIMIT found is capped. A subquery
    // LIMIT gets capped; the outer query gets none appended.
    if (parseInt(match[1], 10) > maxRows) {
      const start = match.index + match[0].indexOf(match[1]);
      const end = start + match[1].length;
      return sql.slice(0, start) + String(maxRows) + sql.slice(end);
    }
    return sql;
  }
  // rstrip() then rstrip(";") then append, mirroring the reference exactly.
  const stripped = sql.replace(/\s+$/, "").replace(/;+$/, "");
  return `${stripped} LIMIT ${maxRows}`;
}

function cellStr(value: unknown, maxCellChars: number): string {
  const truncate = (s: string): string =>
    s.length <= maxCellChars ? s : s.slice(0, maxCellChars) + "…";
  if (Array.isArray(value)) {
    return value.map((item) => truncate(String(item))).join("\n");
  }
  return truncate(String(value));
}

/**
 * Format DB rows as a pipe-delimited table, truncating as needed.
 * `rows` must be a non-empty array of column-keyed objects (node-postgres
 * `res.rows`). Column order comes from the first row's keys.
 */
export function formatQueryResults(
  rows: Array<Record<string, unknown>>,
  maxCellChars: number = MAX_CELL_CHARS,
  maxOutputChars: number = MAX_OUTPUT_CHARS,
): string {
  const headers = Object.keys(rows[0]);
  const lines: string[] = [headers.join(" | ")];
  lines.push("-".repeat(lines[0].length));
  for (const row of rows) {
    lines.push(headers.map((h) => cellStr(row[h], maxCellChars)).join(" | "));
  }
  lines.push(`\n${rows.length} row(s) returned.`);
  let result = lines.join("\n");
  if (result.length > maxOutputChars) {
    result =
      result.slice(0, maxOutputChars) +
      "\n\n[Output truncated: result exceeded size limit. " +
      "Re-query without STRING_AGG or large aggregated columns, " +
      "or narrow the result set.]";
  }
  return result;
}
