/**
 * Reversible rollout flag for the unified dashboard snapshot
 * consumption.
 *
 * Controls whether the dashboard page reads every above-the-fold tile
 * from the single `GET /api/dashboard/snapshot` cell (default) or falls
 * back to the legacy four independent cells (slim analytics + thick
 * analytics + mood + widget layout). The snapshot path is the desired
 * behaviour: one un-gated request hydrates the whole strip so every
 * tile shares one completion moment, instead of four parallel cells
 * where the mood cache resolves fastest and pops in ahead of the rest.
 *
 * Default ON. Set `NEXT_PUBLIC_DASHBOARD_SNAPSHOT=false` to fall back
 * to the legacy multi-cell path. Defaulting on (rather than gating on
 * `=== "true"`) avoids the `NEXT_PUBLIC_*` build-time-baking trap: the
 * snapshot path is exercised in dev / e2e without a special build
 * flag, and the production image gets it without a Dockerfile ARG.
 */
export function isDashboardSnapshotEnabled(): boolean {
  return process.env.NEXT_PUBLIC_DASHBOARD_SNAPSHOT !== "false";
}
