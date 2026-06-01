/**
 * v1.5.6 — pg-boss queue + boot-time converging backfill for the
 * legacy step consolidation pass. Modelled on the
 * `rollup-full-backfill` boot-time pattern: a discovery query enqueues
 * one job per user still holding live legacy step rows, the per-user
 * handler runs `consolidateLegacySteps`, and the pass is idempotent
 * across reboots (consolidated rows are soft-deleted so they drop off
 * the discovery list).
 *
 * The queue name MUST be registered in `allQueues` in
 * `src/lib/jobs/reminder-worker.ts` so pg-boss provisions it at boot;
 * an unregistered queue silently never drains.
 */
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import { consolidateLegacySteps } from "@/lib/measurements/consolidate-legacy-steps";

export const STEP_CONSOLIDATION_QUEUE = "step-consolidation";

/**
 * Serial concurrency — the populator walks every legacy step row for a
 * user and writes in a transaction per day; concurrency-1 keeps it from
 * crowding the request pool, matching `ROLLUP_FULL_BACKFILL_CONCURRENCY`.
 */
export const STEP_CONSOLIDATION_CONCURRENCY = 1;

export interface StepConsolidationPayload {
  userId: string;
  enqueuedAt: string;
}

/**
 * Per-user queue handler. Runs the consolidation for one account and
 * returns the summary totals so the worker can log them.
 */
export async function runStepConsolidationForUser(
  userId: string,
): Promise<{ daysConsolidated: number; legacyRowsSoftDeleted: number }> {
  const summary = await consolidateLegacySteps(prisma, {
    userId,
    log: () => {
      // Silent inside the queue handler — the worker logs the totals.
    },
  });
  // Stable wide-event action name (`<surface>.<noun>.<verb>`). No-ops
  // outside a request/job event context.
  annotate({
    action: {
      name: "measurement.step.consolidate",
      details: {
        days: summary.totals.daysConsolidated,
        legacy_rows_soft_deleted: summary.totals.legacyRowsSoftDeleted,
        days_folded_into_existing: summary.totals.daysFoldedIntoExisting,
      },
    },
  });
  return {
    daysConsolidated: summary.totals.daysConsolidated,
    legacyRowsSoftDeleted: summary.totals.legacyRowsSoftDeleted,
  };
}

/**
 * Boot-time discovery. Finds every user with at least one LIVE legacy
 * step row (an `ACTIVITY_STEPS` row whose `externalId` is NULL or does
 * NOT start with the daily-stats prefix, and that is not tombstoned)
 * and enqueues one consolidation job per account.
 *
 * Idempotent across reboots: once a user's legacy rows are
 * soft-deleted, the `deleted_at IS NULL` predicate drops them from the
 * discovery set and the user falls off the list. pg-boss `singletonKey`
 * coalesces duplicate sends within the queue so a fast restart while a
 * job is queued doesn't double up.
 *
 * Best-effort: errors are returned through the result value so the
 * worker boot never fails because of a consolidation miss.
 */
export async function enqueueBootTimeStepConsolidation(): Promise<{
  enqueued: number;
  skipped: number;
  error: string | null;
}> {
  const boss = getGlobalBoss();
  if (!boss) {
    return { enqueued: 0, skipped: 0, error: null };
  }

  try {
    // The daily-total externalId shape is `stats:<HK>:<YYYY-MM-DD>`. A
    // live row is a legacy candidate when its externalId does NOT match
    // that prefix (NULL externalId — a manual/legacy row — also
    // qualifies because `LIKE` against NULL is NULL/false). Splice-free:
    // the prefix is a constant compile-time literal, not user input.
    const users = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT DISTINCT m."user_id" AS id
      FROM measurements m
      WHERE m."type" = 'ACTIVITY_STEPS'
        AND m."deleted_at" IS NULL
        AND (
          m."external_id" IS NULL
          OR m."external_id" NOT LIKE 'stats:HKQuantityTypeIdentifierStepCount:%'
        )
    `;

    if (users.length === 0) {
      return { enqueued: 0, skipped: 0, error: null };
    }

    let enqueued = 0;
    let skipped = 0;
    for (const { id } of users) {
      const payload: StepConsolidationPayload = {
        userId: id,
        enqueuedAt: new Date().toISOString(),
      };
      const jobId = await boss.send(STEP_CONSOLIDATION_QUEUE, payload, {
        retryLimit: 3,
        retryDelay: 60,
        retryBackoff: true,
        singletonKey: `step-consolidation|${id}`,
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
