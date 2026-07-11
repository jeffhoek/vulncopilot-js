import type { Pool } from "pg";

// ETL run history for the public /etl-stats page (Phase 6). Port of reference
// `rag/etl_stats.py`. The shaping functions are pure and exported so the
// public-exposure hardening can be unit-tested without a DB.
//
// PUBLIC-EXPOSURE HARDENING (reference `_shape_loader`): the per-loader `error`
// field is raw exception text and can leak internal detail (paths, connection
// strings). This page NEVER echoes it — on a failed loader it shows a generic
// "failed" note. The `metrics` field is likewise not rendered. Only label, ok,
// elapsed, and (on success) the loader's own summary line reach the client.

// One loader's raw outcome as stored in the `etl_runs.results` JSONB array.
// `error` and `metrics` are intentionally typed but never read past this file.
export interface EtlLoaderRaw {
  label?: string;
  ok?: boolean;
  elapsed?: number;
  summary?: string;
  metrics?: unknown;
  error?: string;
}

// A row from `etl_runs` as returned by pg. pg parses JSONB to a JS value and
// TIMESTAMPTZ to a Date, but both are handled defensively (mirrors the
// reference, which re-parses a JSON string from asyncpg).
export interface EtlRunRow {
  run_at: Date | string;
  status: string;
  total_elapsed: string | number;
  results: EtlLoaderRaw[] | string;
}

export interface ShapedLoader {
  label: string;
  ok: boolean;
  elapsed: string;
  detail: string;
}

export interface ShapedRun {
  runAt: string;
  status: string;
  ok: boolean;
  totalElapsed: string;
  loaders: ShapedLoader[];
}

/** `{m}m{ss}s` from whole seconds — port of reference `_fmt_duration`. */
export function fmtDuration(seconds: number): string {
  const total = Math.trunc(seconds) || 0;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}m${String(s).padStart(2, "0")}s`;
}

/** `YYYY-MM-DD HH:MM UTC` — the UTC wall-clock, matching the reference's
 * `.strftime("%Y-%m-%d %H:%M UTC")` on an aware (UTC) datetime. */
export function fmtRunAt(runAt: Date | string): string {
  const d = runAt instanceof Date ? runAt : new Date(runAt);
  const iso = d.toISOString(); // 2026-07-09T23:31:05.000Z
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** Public-safe view of one loader — NEVER the raw `error`. Port of `_shape_loader`. */
export function shapeLoader(loader: EtlLoaderRaw): ShapedLoader {
  const ok = Boolean(loader.ok);
  return {
    label: loader.label ?? "",
    ok,
    elapsed: fmtDuration(Number(loader.elapsed) || 0),
    // Success: the loader's own summary is safe descriptive text. Failure: a
    // generic note, never the raw exception string.
    detail: ok ? (loader.summary ?? "") : "failed",
  };
}

/** Port of reference `_shape_run`. */
export function shapeRun(run: EtlRunRow): ShapedRun {
  const results: EtlLoaderRaw[] =
    typeof run.results === "string" ? JSON.parse(run.results) : (run.results ?? []);
  return {
    runAt: fmtRunAt(run.run_at),
    status: run.status,
    ok: run.status === "SUCCESS",
    totalElapsed: fmtDuration(Number(run.total_elapsed) || 0),
    loaders: results.map(shapeLoader),
  };
}

/**
 * Most-recent ETL runs, newest first, shaped for public display. Port of
 * reference `get_recent_runs` + `render_etl_stats_html`'s shaping. The
 * `etl_runs_run_at_idx` index keeps the ordered scan fast; LIMIT keeps the page
 * responsive regardless of table size. No auth — this is a public page.
 */
export async function getRecentEtlRuns(pool: Pool, limit = 50): Promise<ShapedRun[]> {
  const res = await pool.query<EtlRunRow>(
    "SELECT run_at, status, total_elapsed, results FROM etl_runs ORDER BY run_at DESC LIMIT $1",
    [limit],
  );
  return res.rows.map(shapeRun);
}
