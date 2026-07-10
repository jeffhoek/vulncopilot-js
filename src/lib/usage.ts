import type { Pool } from "pg";

// Per-user daily usage tracking for rate limiting. Ported from reference
// `rag/usage.py`. `pool` is passed in (never imported here) so `limitFor` stays
// free of the config/db import chain and remains unit-testable without a filled
// `.env` — the same pattern as `auth-allowlist.ts`.

// Single atomic statement: insert today's row or bump the existing one. The
// UNIQUE (user_identifier, query_date) constraint makes ON CONFLICT fire, so two
// concurrent requests can't both pass a separate check before either increments.
// Ported verbatim from reference `rag/usage.py::_INCREMENT_SQL`.
const INCREMENT_SQL = `
INSERT INTO user_usage (user_identifier, query_date, query_count, input_tokens, output_tokens)
VALUES ($1, CURRENT_DATE, 1, $2, $3)
ON CONFLICT (user_identifier, query_date) DO UPDATE SET
    query_count   = user_usage.query_count   + 1,
    input_tokens  = user_usage.input_tokens  + EXCLUDED.input_tokens,
    output_tokens = user_usage.output_tokens + EXCLUDED.output_tokens
RETURNING query_count
`;

export interface RateLimitConfig {
  dailyQueryLimit: number;
  adminDailyQueryLimit: number;
  adminUserIdentifiers: string[];
}

/**
 * Effective daily query limit for a user — elevated for listed admins.
 * Ported from reference `app.py::_limit_for`. Pure; config passed in so the
 * boundary semantics can be unit-tested (see usage.test.ts, a port of
 * reference `tests/unit/test_rate_limit.py`).
 */
export function limitFor(userId: string, cfg: RateLimitConfig): number {
  return cfg.adminUserIdentifiers.includes(userId)
    ? cfg.adminDailyQueryLimit
    : cfg.dailyQueryLimit;
}

/**
 * Atomically record one query's usage and report whether it was within limit.
 * Returns `{ allowed, newCount }` where `allowed = newCount <= limit`. This is
 * the authoritative gate — the cheap pre-check (currentDailyCount) only avoids
 * spending an LLM call on an already-blocked user. Port of reference
 * `rag/usage.py::check_and_increment`. pg returns bigint counts as strings —
 * coerce to number.
 */
export async function checkAndIncrement(
  pool: Pool,
  userId: string,
  limit: number,
  inputTokens: number,
  outputTokens: number,
): Promise<{ allowed: boolean; newCount: number }> {
  const res = await pool.query<{ query_count: string }>(INCREMENT_SQL, [
    userId,
    inputTokens,
    outputTokens,
  ]);
  const newCount = Number(res.rows[0].query_count);
  return { allowed: newCount <= limit, newCount };
}

/**
 * Today's query count for a user (0 if no row yet). Cheap best-effort pre-check
 * used before the LLM call; the reference blocks when `query_count >= limit`
 * (reference `app.py::enforce_daily_limit`).
 */
export async function currentDailyCount(pool: Pool, userId: string): Promise<number> {
  const res = await pool.query<{ query_count: string }>(
    "SELECT query_count FROM user_usage WHERE user_identifier = $1 AND query_date = CURRENT_DATE",
    [userId],
  );
  return res.rows.length ? Number(res.rows[0].query_count) : 0;
}

/** Verbatim limit message (reference `app.py::_limit_message`). */
export function limitMessage(limit: number): string {
  return `You've reached your daily limit of ${limit} queries. Try again tomorrow.`;
}
