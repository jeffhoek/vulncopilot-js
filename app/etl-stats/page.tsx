import { pool } from "@/src/lib/db";
import { getRecentEtlRuns, type ShapedRun } from "@/src/lib/etl-stats";

// Public /etl-stats page (Phase 6). No auth — always-on, scrollable,
// newest-first ETL run history (LIMIT 50). Port of reference `rag/etl_stats.py`.
// The public-exposure hardening (never render the raw per-loader `error`) lives
// in the shaping functions in src/lib/etl-stats.ts.
export const dynamic = "force-dynamic";

export default async function EtlStats() {
  let runs: ShapedRun[] = [];
  let loadError = false;
  try {
    runs = await getRecentEtlRuns(pool, 50);
  } catch (err) {
    console.error("Failed to load ETL runs", err);
    loadError = true;
  }

  return (
    <div className="etl">
      {/* Reload an open tab periodically so a new ETL run eventually shows up
          without a manual refresh. Kept well above the ETL cadence (twice daily).
          Ported from the reference template's <meta http-equiv="refresh">. */}
      <meta httpEquiv="refresh" content="1800" />
      <h1>ETL run history</h1>
      <p className="etl-sub">CISA KEV &amp; NIST NVD refresh — newest first.</p>
      {loadError ? (
        <div className="etl-empty">Failed to load ETL run history.</div>
      ) : runs.length === 0 ? (
        <div className="etl-empty">No ETL runs recorded yet.</div>
      ) : (
        <div className="etl-scroll">
          <table className="etl-table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Run (UTC)</th>
                <th>Total</th>
                <th>Loaders</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run, i) => (
                <tr key={i}>
                  <td>
                    <span className={`etl-badge ${run.ok ? "ok" : "fail"}`}>{run.status}</span>
                  </td>
                  <td>
                    <time className="dur">{run.runAt}</time>
                  </td>
                  <td className="dur">{run.totalElapsed}</td>
                  <td>
                    <ul className="etl-loaders">
                      {run.loaders.map((loader, j) => (
                        <li key={j}>
                          {loader.ok ? "✓" : "✗"} <strong>{loader.label}</strong>{" "}
                          <span className="dur">({loader.elapsed})</span>
                          {loader.detail ? ` — ${loader.detail}` : ""}
                        </li>
                      ))}
                    </ul>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
