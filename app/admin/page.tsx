import { config } from "@/src/lib/config";
import { pool } from "@/src/lib/db";
import { getUsageStats, type UsageStat } from "@/src/lib/usage";
import { auth } from "@/auth";
import { SignIn } from "../signin";

// Read-only /admin usage dashboard (Phase 5). Session-gated to
// ADMIN_USER_IDENTIFIERS — the reference's HTTP Basic / ADMIN_SECRET scheme is
// dropped by design (CLAUDE.md). Signed-out visitors get the sign-in view;
// signed-in non-admins get a forbidden notice. Renders per-user query counts,
// all-time token totals, and estimated LLM cost (port of reference
// admin/dashboard.py + templates/dashboard.html).
export const dynamic = "force-dynamic";

// Thousands-separated integer, matching the reference's `{:,}` token formatting.
const int = (n: number) => n.toLocaleString("en-US");

export default async function Admin() {
  const session = await auth();

  // Signed-out → reuse the sign-in view (same as the chat page).
  if (!session?.userId) {
    return <SignIn />;
  }

  // Signed-in but not an admin → forbidden. Both this and the signed-out case
  // satisfy the Phase 5 DoD ("non-admin and signed-out are denied").
  if (!config.ADMIN_USER_IDENTIFIERS.includes(session.userId)) {
    return (
      <div className="signin">
        <div className="signin-card">
          <h1>Not authorized</h1>
          <p className="tagline">This page is restricted to administrators.</p>
        </div>
      </div>
    );
  }

  let rows: UsageStat[] = [];
  let loadError = false;
  try {
    rows = await getUsageStats(
      pool,
      config.LLM_INPUT_COST_PER_MILLION,
      config.LLM_OUTPUT_COST_PER_MILLION,
    );
  } catch (err) {
    console.error("Failed to load usage stats", err);
    loadError = true;
  }

  return (
    <div className="admin">
      <h1>Usage dashboard</h1>
      <p className="admin-sub">Per-user query counts and estimated LLM cost.</p>
      {loadError ? (
        <div className="admin-empty">Failed to load usage data.</div>
      ) : rows.length === 0 ? (
        <div className="admin-empty">No usage recorded yet.</div>
      ) : (
        <div className="admin-scroll">
          <table className="admin-table">
            <thead>
              <tr>
                <th>User</th>
                <th className="num">Queries Today</th>
                <th className="num">Last 7 Days</th>
                <th className="num">Last 30 Days</th>
                <th className="num">Total Input Tokens</th>
                <th className="num">Total Output Tokens</th>
                <th className="num">Est. Cost (USD)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.userIdentifier}>
                  <td>{r.userIdentifier}</td>
                  <td className="num">{r.queriesToday}</td>
                  <td className="num">{r.queries7d}</td>
                  <td className="num">{r.queries30d}</td>
                  <td className="num">{int(r.inputTokens)}</td>
                  <td className="num">{int(r.outputTokens)}</td>
                  <td className="num">${r.estCost.toFixed(4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
