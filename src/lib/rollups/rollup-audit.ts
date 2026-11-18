/**
 * The nightly audit of the DAY rollup tier against the record.
 *
 * Every write recomputes the DAY bucket of each day it touches, inline
 * (`afterMeasurementMutation`). That recompute is best-effort: when it fails,
 * the write still lands, the failure is logged, and the bucket keeps the
 * figures from before the write. The readers that let the tier stand in for
 * the record check it only at the ends of their range
 * (`readTierCoveredTypes`), because a per-day comparison on the read path is
 * the read of every row it exists to avoid. A day in the middle that a failed
 * recompute left behind would be served from then on.
 *
 * This pass is where such a day is found. A recompute fails on a write, and a
 * write stamps `updated_at` on every row it inserts, edits or soft-deletes, so
 * the days that can disagree are the days holding a row written since the
 * last pass. For each account, those days (inside the fold window, the only
 * days the tier holds) are compared bucket for bucket: the live reading count
 * and value sum against the tier's, summed over its sources, which fold the
 * same rows. A day that differs is refolded through the same recompute the
 * write path runs, and counted. The lookback is two days for a nightly tick,
 * so a skipped night is still covered.
 *
 * Bounded by what was written, not by the history: one range of the
 * `(user_id, updated_at, id)` index per account, and two days' rows at most
 * per touched day.
 */
import { prisma } from "@/lib/db";
import type { MeasurementType } from "@/generated/prisma/client";
import {
  recomputeBucketsForKeys,
  ROLLUP_FOLD_WINDOW_MS,
} from "@/lib/rollups/measurement-rollups";

/** How far back a pass looks for written rows. */
export const ROLLUP_AUDIT_LOOKBACK_HOURS = 48;

export interface RollupAuditSummary {
  usersScanned: number;
  daysChecked: number;
  /** Days whose bucket disagreed with the record and was refolded. */
  daysRefolded: number;
  /** Accounts whose refold threw; their days stay for the next pass. */
  usersFailed: number;
  stoppedEarly: boolean;
}

interface DayVerdict {
  type: string;
  day: Date;
  live_n: bigint | number;
  live_sum: number | null;
  tier_n: bigint | number;
  tier_sum: number | null;
  tier_sum_known: boolean | null;
}

/** The touched days of one account that disagree with their DAY bucket. */
export async function readDisagreeingDays(
  userId: string,
  since: Date,
  now: Date = new Date(),
): Promise<{
  checked: number;
  disagreeing: Array<{ type: MeasurementType; day: Date }>;
}> {
  const edge = new Date(now.getTime() - ROLLUP_FOLD_WINDOW_MS);
  const rows = await prisma.$queryRaw<DayVerdict[]>`
    WITH touched AS (
      SELECT DISTINCT m."type", date_trunc('day', m."measured_at") AS day
      FROM measurements m
      WHERE m."user_id" = ${userId}
        AND m."updated_at" >= ${since}
        AND m."measured_at" >= ${edge}
    )
    SELECT t."type"::text AS type, t.day,
           live.n AS live_n, live.s AS live_sum,
           tier.n AS tier_n, tier.s AS tier_sum, tier.known AS tier_sum_known
    FROM touched t
    CROSS JOIN LATERAL (
      SELECT COUNT(*) AS n, SUM(l."value")::double precision AS s
      FROM measurements l
      WHERE l."user_id" = ${userId}
        AND l."type" = t."type"
        AND l."deleted_at" IS NULL
        AND l."measured_at" >= t.day
        AND l."measured_at" < t.day + interval '1 day'
    ) live
    CROSS JOIN LATERAL (
      SELECT COALESCE(SUM(r."count"), 0) AS n,
             SUM(r."sum_value")::double precision AS s,
             bool_and(r."sum_value" IS NOT NULL) AS known
      FROM measurement_rollups r
      WHERE r."user_id" = ${userId}
        AND r."type" = t."type"
        AND r."granularity" = 'DAY'
        AND r."bucket_start" = t.day AT TIME ZONE 'UTC'
    ) tier
  `;
  const disagreeing = rows
    .filter((r) => {
      if (Number(r.live_n) !== Number(r.tier_n)) return true;
      if (Number(r.live_n) === 0 || r.tier_sum_known !== true) return false;
      const live = Number(r.live_sum ?? 0);
      const tier = Number(r.tier_sum ?? 0);
      return Math.abs(live - tier) > 1e-9 * Math.max(1, Math.abs(live));
    })
    .map((r) => ({
      type: r.type as MeasurementType,
      // `day` is a UTC midnight read back as a timestamp without zone.
      day: new Date(r.day),
    }));
  return { checked: rows.length, disagreeing };
}

export async function auditRecentRollupDays(
  options: {
    now?: Date;
    lookbackHours?: number;
    shouldStop?: () => boolean;
    log?: (line: string) => void;
  } = {},
): Promise<RollupAuditSummary> {
  const now = options.now ?? new Date();
  const since = new Date(
    now.getTime() -
      (options.lookbackHours ?? ROLLUP_AUDIT_LOOKBACK_HOURS) * 3_600_000,
  );
  const summary: RollupAuditSummary = {
    usersScanned: 0,
    daysChecked: 0,
    daysRefolded: 0,
    usersFailed: 0,
    stoppedEarly: false,
  };
  const users = await prisma.user.findMany({
    select: { id: true },
    orderBy: { id: "asc" },
  });
  for (const { id } of users) {
    if (options.shouldStop?.()) {
      summary.stoppedEarly = true;
      break;
    }
    summary.usersScanned++;
    try {
      const { checked, disagreeing } = await readDisagreeingDays(
        id,
        since,
        now,
      );
      summary.daysChecked += checked;
      if (disagreeing.length > 0) {
        await recomputeBucketsForKeys(
          id,
          disagreeing.map((d) => ({ type: d.type, measuredAt: d.day })),
        );
        summary.daysRefolded += disagreeing.length;
      }
    } catch (err) {
      summary.usersFailed++;
      options.log?.(
        `[rollup-audit] account failed: ${err instanceof Error ? err.name : "unknown"}`,
      );
    }
  }
  options.log?.(
    `[rollup-audit] usersScanned=${summary.usersScanned} daysChecked=${summary.daysChecked} daysRefolded=${summary.daysRefolded} usersFailed=${summary.usersFailed}`,
  );
  return summary;
}
