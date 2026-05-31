/**
 * v1.7.0 W6 — reversible rollout flag for the unified dashboard
 * snapshot consumption (R-firstpaint §6 rollout).
 *
 * The `GET /api/dashboard/snapshot` endpoint and the
 * `insight-pregenerate` cron ship inert in step 1. This flag controls
 * step 2 — whether the dashboard page reads every tile from the single
 * snapshot cell (flag ON) or keeps the legacy four independent cells
 * (flag OFF, today's behaviour, zero risk). Default OFF so the swap is
 * opt-in until the stagger is verified gone in production.
 *
 * Build-time `NEXT_PUBLIC_*` env var so the bundle is statically
 * branched; flipping it is a redeploy, not a runtime toggle, which
 * keeps the off-path bundle identical to today's.
 */
export function isDashboardSnapshotEnabled(): boolean {
  return process.env.NEXT_PUBLIC_DASHBOARD_SNAPSHOT === "true";
}
