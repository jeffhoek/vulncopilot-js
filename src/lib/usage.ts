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

// Per-user aggregate for the /admin dashboard. Query counts are windowed
// (today / last 7 / last 30 days, each window inclusive of today); token totals
// are all-time so the estimated cost reflects everything the user has spent.
// Ported verbatim from reference `rag/usage.py::_STATS_SQL`.
const STATS_SQL = `
SELECT
    user_identifier,
    COALESCE(SUM(query_count) FILTER (WHERE query_date = CURRENT_DATE), 0)                      AS queries_today,
    COALESCE(SUM(query_count) FILTER (WHERE query_date >= CURRENT_DATE - INTERVAL '6 days'), 0) AS queries_7d,
    COALESCE(SUM(query_count) FILTER (WHERE query_date >= CURRENT_DATE - INTERVAL '29 days'), 0) AS queries_30d,
    COALESCE(SUM(input_tokens), 0)  AS input_tokens,
    COALESCE(SUM(output_tokens), 0) AS output_tokens
FROM user_usage
GROUP BY user_identifier
ORDER BY queries_30d DESC, user_identifier
`;

export interface UsageStat {
  userIdentifier: string;
  queriesToday: number;
  queries7d: number;
  queries30d: number;
  inputTokens: number;
  outputTokens: number;
  estCost: number;
}

/**
 * Estimated USD cost from token totals and per-million prices. Pure and
 * exported so the cost math can be unit-tested without a DB. Ported from
 * reference `rag/usage.py::get_usage_stats` (the est_cost expression).
 */
export function estimateCost(
  inputTokens: number,
  outputTokens: number,
  inputCostPerMillion: number,
  outputCostPerMillion: number,
): number {
  return (
    (inputTokens / 1_000_000) * inputCostPerMillion +
    (outputTokens / 1_000_000) * outputCostPerMillion
  );
}

/**
 * Per-user usage aggregate for the admin dashboard: windowed query counts
 * (today / 7-day / 30-day), all-time token totals, and an estimated USD cost
 * from the supplied per-million prices (kept out of this module so config stays
 * the single source of truth). Port of reference `rag/usage.py::get_usage_stats`.
 * pg returns SUM()/bigint columns as strings — coerce to number.
 */
export async function getUsageStats(
  pool: Pool,
  inputCostPerMillion: number,
  outputCostPerMillion: number,
): Promise<UsageStat[]> {
  const res = await pool.query<{
    user_identifier: string;
    queries_today: string;
    queries_7d: string;
    queries_30d: string;
    input_tokens: string;
    output_tokens: string;
  }>(STATS_SQL);
  return res.rows.map((r) => {
    const inputTokens = Number(r.input_tokens);
    const outputTokens = Number(r.output_tokens);
    return {
      userIdentifier: r.user_identifier,
      queriesToday: Number(r.queries_today),
      queries7d: Number(r.queries_7d),
      queries30d: Number(r.queries_30d),
      inputTokens,
      outputTokens,
      estCost: estimateCost(inputTokens, outputTokens, inputCostPerMillion, outputCostPerMillion),
    };
  });
}
