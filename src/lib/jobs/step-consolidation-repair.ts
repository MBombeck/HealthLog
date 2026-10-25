/**
 * v1.28.37 — pg-boss queue + boot-time one-shot repair for the step
 * data-loss the pre-fix legacy step consolidation caused.
 *
 * Background: before this release the boot-time legacy step consolidation
 * (`consolidate-legacy-steps.ts`) discovered any live `ACTIVITY_STEPS` row
 * whose externalId was not the narrow `stats:HKQuantityTypeIdentifierStepCount:`
 * shape and soft-deleted it — sweeping GOOGLE_HEALTH and FITBIT daily-total
 * rows (`stats:steps:<day>`) on every worker boot and, on days without an
 * Apple total, minting a shadow `MANUAL` `stats:HK…` total from the summed
 * provider value. The predicate + source-pin fix stops the sweep going
 * forward; this job repairs the rows already tombstoned.
 *
 * What it does, per account, self-convergingly:
 *   1. RESURRECT (`deletedAt: null`) tombstoned GOOGLE_HEALTH / FITBIT
 *      `stats:%` `ACTIVITY_STEPS` rows within the 75-day tombstone-retention
 *      horizon (older tombstones are already hard-pruned; those days need one
 *      final full sync per account). Wedge-safe: a row is resurrected ONLY if
 *      no live row already occupies its `(userId, type, source, measuredAt)`
 *      slot — the tombstone-wedge lesson (probe first). A per-row P2002
 *      catch is a belt on top of the probe for the concurrent-write race.
 *   2. REMOVE the shadow MANUAL `stats:HK…:<day>` total the bug minted, but
 *      ONLY for a day where a live GOOGLE_HEALTH / FITBIT `stats:steps:<day>`
 *      total now returns (soft-delete, recoverable — never hard-delete). A
 *      MANUAL total on a day with no provider row is left untouched: it may
 *      be a genuine Apple-legacy consolidation.
 *   3. Recompute the DAY rollup bucket for every touched day so the dashboard
 *      tier follows the resurrected/removed rows.
 *
 * Converges to zero without a marker column: once a tombstoned provider row
 * is resurrected it is live and drops out of the discovery predicate; a
 * wedge-blocked row (a live sibling already occupies its slot — the data is
 * NOT lost) is excluded from discovery by the `NOT EXISTS` clause, so it
 * never keeps an account on the list. A re-run (reboot mid-walk) re-selects
 * only the still-tombstoned, still-resurrectable rows.
 *
 * The queue name MUST be registered in `allQueues` in
 * `src/lib/jobs/reminder/register-rollup.ts` or pg-boss never provisions it
 * and the boot enqueue silently never drains (the v1.4.37 dead-queue class).
 */
import { dropPendingDeletion } from "@/lib/account-deletion/active-account";
import type { MeasurementSource } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import { isP2002 as isUniqueConstraintViolation } from "@/lib/prisma-errors";
import { recomputeBucketsForMeasurement } from "@/lib/rollups/measurement-rollups";
import { TOMBSTONE_RETENTION_DAYS } from "@/lib/auth/native-client";

export const STEP_CONSOLIDATION_REPAIR_QUEUE = "step-consolidation-repair";

/**
 * Serial concurrency — a repair walks one account's tombstoned provider
 * step rows and writes per day; concurrency-1 keeps it from crowding the
 * request pool, matching `STEP_CONSOLIDATION_CONCURRENCY`.
 */
export const STEP_CONSOLIDATION_REPAIR_CONCURRENCY = 1;

/** Providers whose swept daily-total step rows this job resurrects. */
const REPAIR_PROVIDER_SOURCES: readonly MeasurementSource[] = [
  "GOOGLE_HEALTH",
  "FITBIT",
] as const;

/** The narrow `stats:HK…` shape the bug minted its shadow MANUAL totals in. */
const STEP_MANUAL_MINT_PREFIX = "stats:HKQuantityTypeIdentifierStepCount:";

const STEP_TYPE = "ACTIVITY_STEPS" as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Trailing `YYYY-MM-DD` day key of a `stats:<tag>:<day>` externalId. */
const STATS_DAY_RE = /(\d{4}-\d{2}-\d{2})$/;

export interface StepConsolidationRepairPayload {
  userId: string;
  enqueuedAt: string;
}

export interface StepConsolidationRepairSummary {
  /** Tombstoned provider daily totals brought back live. */
  rowsResurrected: number;
  /** Rows left tombstoned because a live sibling occupies their slot. */
  wedgeSkipped: number;
  /** Shadow MANUAL totals soft-deleted because a provider row now returns. */
  manualMintsRemoved: number;
  /** Distinct DAY rollup buckets recomputed. */
  daysRecomputed: number;
  /** Rows/mints stepped over after an unexpected write error. */
  failures: number;
}

/** Extract the `YYYY-MM-DD` day key from a `stats:` externalId, or null. */
export function extractStatsDay(externalId: string | null): string | null {
  if (!externalId) return null;
  const match = STATS_DAY_RE.exec(externalId);
  return match ? match[1] : null;
}

/**
 * Per-user repair handler. Idempotent and self-converging — see the file
 * header. Returns the summary totals so the worker can log them.
 */
export async function runStepConsolidationRepairForUser(
  userId: string,
): Promise<StepConsolidationRepairSummary> {
  const summary: StepConsolidationRepairSummary = {
    rowsResurrected: 0,
    wedgeSkipped: 0,
    manualMintsRemoved: 0,
    daysRecomputed: 0,
    failures: 0,
  };

  const cutoff = new Date(Date.now() - TOMBSTONE_RETENTION_DAYS * DAY_MS);

  // Touched UTC-day → a representative instant in that day, for one rollup
  // recompute per affected bucket (the rollup tier keys DAY buckets by UTC
  // day; a resurrected provider row and a removed local-noon mint can land
  // in different UTC days, so both instants are tracked).
  const touchedByUtcDay = new Map<string, Date>();
  const markTouched = (instant: Date) => {
    // eslint-disable-next-line healthlog/no-utc-day-key -- UTC by design: the rollup tier keys DAY buckets by UTC day (see the comment above)
    touchedByUtcDay.set(instant.toISOString().slice(0, 10), instant);
  };

  // ── 1. Resurrect tombstoned provider daily totals ────────────────────
  const tombstoned = await prisma.measurement.findMany({
    where: {
      userId,
      type: STEP_TYPE,
      source: { in: [...REPAIR_PROVIDER_SOURCES] },
      externalId: { startsWith: "stats:" },
      // Within the retention horizon: older tombstones are already pruned.
      deletedAt: { not: null, gte: cutoff },
    },
    select: { id: true, source: true, measuredAt: true, externalId: true },
  });

  for (const row of tombstoned) {
    // Wedge probe: never resurrect into a slot a live row already holds —
    // the second unique index `(userId, type, measuredAt, source, sleepStage)`
    // covers tombstones, so a static collision cannot arise, but a
    // concurrent provider sync could have re-created the day live. Skip it:
    // the live row is the current truth and the data is not lost.
    const liveSibling = await prisma.measurement.findFirst({
      where: {
        userId,
        type: STEP_TYPE,
        source: row.source,
        measuredAt: row.measuredAt,
        sleepStage: null,
        deletedAt: null,
      },
      select: { id: true },
    });
    if (liveSibling) {
      summary.wedgeSkipped += 1;
      continue;
    }

    try {
      await prisma.measurement.update({
        where: { id: row.id },
        data: { deletedAt: null },
      });
      summary.rowsResurrected += 1;
      markTouched(row.measuredAt);
    } catch (err) {
      // A racing insert between the probe and this update can trip the
      // unique index. Step over the row — a later boot re-selects it.
      if (isUniqueConstraintViolation(err)) {
        summary.wedgeSkipped += 1;
        continue;
      }
      summary.failures += 1;
    }
  }

  // ── 2. Remove shadow MANUAL mints where a provider row now returns ────
  const manualMints = await prisma.measurement.findMany({
    where: {
      userId,
      type: STEP_TYPE,
      source: "MANUAL",
      externalId: { startsWith: STEP_MANUAL_MINT_PREFIX },
      deletedAt: null,
    },
    select: { id: true, measuredAt: true, externalId: true },
  });

  for (const mint of manualMints) {
    const day = extractStatsDay(mint.externalId);
    if (!day) continue;

    // Only remove the mint when a LIVE provider daily total for the same
    // day exists — that is the discriminator between a spurious shadow of
    // provider data and a genuine Apple-legacy consolidation.
    const providerRow = await prisma.measurement.findFirst({
      where: {
        userId,
        type: STEP_TYPE,
        source: { in: [...REPAIR_PROVIDER_SOURCES] },
        externalId: `stats:steps:${day}`,
        deletedAt: null,
      },
      select: { id: true },
    });
    if (!providerRow) continue;

    try {
      await prisma.measurement.update({
        where: { id: mint.id },
        data: { deletedAt: new Date() },
      });
      summary.manualMintsRemoved += 1;
      markTouched(mint.measuredAt);
    } catch {
      summary.failures += 1;
    }
  }

  // ── 3. Recompute the DAY rollup bucket for every touched day ──────────
  for (const instant of touchedByUtcDay.values()) {
    try {
      await recomputeBucketsForMeasurement(userId, STEP_TYPE, instant);
      summary.daysRecomputed += 1;
    } catch {
      summary.failures += 1;
    }
  }

  // Stable wide-event action name. No-ops outside a request/job context.
  annotate({
    action: {
      name: "measurement.step.repair",
      details: {
        rows_resurrected: summary.rowsResurrected,
        wedge_skipped: summary.wedgeSkipped,
        manual_mints_removed: summary.manualMintsRemoved,
        days_recomputed: summary.daysRecomputed,
        failures: summary.failures,
      },
    },
  });

  return summary;
}

/**
 * Boot-time discovery. Finds every account still holding a resurrectable
 * tombstoned GOOGLE_HEALTH / FITBIT `stats:%` step row (tombstoned within
 * the retention horizon, with no live sibling occupying its slot) and
 * enqueues one repair job per account.
 *
 * Self-converging: a resurrected row goes live and drops out; a
 * wedge-blocked row is excluded by the `NOT EXISTS` clause so it never
 * keeps an account on the list. Best-effort: errors return through the
 * result so worker boot never fails on a repair miss.
 */
export async function enqueueBootTimeStepConsolidationRepair(
  startAfterSeconds: number = 0,
): Promise<{ enqueued: number; skipped: number; error: string | null }> {
  const boss = getGlobalBoss();
  if (!boss) {
    return { enqueued: 0, skipped: 0, error: null };
  }

  try {
    // Splice-free: every literal is a compile-time constant; the horizon
    // is a bound parameter. `NOT EXISTS` excludes wedge-blocked rows so the
    // set shrinks to empty once every resurrectable row is live.
    const users = await dropPendingDeletion(
      prisma,
      await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT DISTINCT t."user_id" AS id
      FROM measurements t
      WHERE t."type" = 'ACTIVITY_STEPS'
        AND t."deleted_at" IS NOT NULL
        AND t."deleted_at" >= (NOW() AT TIME ZONE 'UTC') - make_interval(days => ${TOMBSTONE_RETENTION_DAYS})
        AND t."source" IN ('GOOGLE_HEALTH', 'FITBIT')
        AND t."external_id" LIKE 'stats:%'
        AND NOT EXISTS (
          SELECT 1
          FROM measurements l
          WHERE l."user_id" = t."user_id"
            AND l."type" = t."type"
            AND l."source" = t."source"
            AND l."measured_at" = t."measured_at"
            AND l."sleep_stage" IS NULL
            AND l."deleted_at" IS NULL
        )
    `,
      (u) => u.id,
    );

    if (users.length === 0) {
      return { enqueued: 0, skipped: 0, error: null };
    }

    let enqueued = 0;
    let skipped = 0;
    for (const { id } of users) {
      const payload: StepConsolidationRepairPayload = {
        userId: id,
        enqueuedAt: new Date().toISOString(),
      };
      const jobId = await boss.send(STEP_CONSOLIDATION_REPAIR_QUEUE, payload, {
        retryLimit: 3,
        retryDelay: 60,
        retryBackoff: true,
        singletonKey: `step-consolidation-repair|${id}`,
        ...(startAfterSeconds > 0 ? { startAfter: startAfterSeconds } : {}),
      });
      if (jobId) {
        enqueued += 1;
      } else {
        skipped += 1;
      }
    }
    return { enqueued, skipped, error: null };
  } catch (err) {
    return {
      enqueued: 0,
      skipped: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
