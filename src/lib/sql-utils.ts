// Ported from the reference Python app: `rag/sql_utils.py`.
// Keep behavior at parity with the reference (including the deliberately-ported
// first-LIMIT quirk in applyRowLimit); the only intentional deviation is the
// multi-statement rejection added to validateSql — asyncpg rejected
// `SELECT 1; DELETE ...` implicitly, node-postgres does not (see IMPLEMENTATION.md).

export const MAX_QUERY_ROWS = 100;
export const MAX_CELL_CHARS = 200;
export const MAX_OUTPUT_CHARS = 20_000;

/** Return an error string if sql is not a single SELECT statement, else null. */
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
