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
import { dropPendingDeletion } from "@/lib/account-deletion/active-account";
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
  // Regression guardrail. `providerRowsSkipped` is 0 in normal operation —
  // the source pin + broad `stats:` skip keep every provider-owned / daily-
  // total step row out of the consolidation scan. A non-zero value means a
  // future change re-broadened the scan and a provider's daily total was
  // about to be soft-deleted (the Google/Fitbit data-loss bug). Emit the
  // wide event only when the canary trips so the signal is cheap and loud.
  if (summary.totals.providerRowsSkipped > 0) {
    annotate({
      action: {
        name: "measurement.step.provider_row_skipped",
        details: { count: summary.totals.providerRowsSkipped },
      },
    });
  }
  return {
    daysConsolidated: summary.totals.daysConsolidated,
    legacyRowsSoftDeleted: summary.totals.legacyRowsSoftDeleted,
  };
}

/**
 * Boot-time discovery. Finds every user with at least one LIVE legacy
 * step row — a non-tombstoned `ACTIVITY_STEPS` row from a writable source
 * (`APPLE_HEALTH` / `MANUAL` / `IMPORT`) whose `externalId` is NULL or is
 * NOT already in a provider's daily-total `stats:%` shape — and enqueues
 * one consolidation job per account.
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
export async function enqueueBootTimeStepConsolidation(
  // Optional boot-storm stagger. When > 0 the per-user sends carry a
  // `startAfter` delay (seconds) so this consolidation does not drain in
  // parallel with the other boot backfills onto one heavy tenant. Default 0
  // keeps immediate semantics for any non-boot caller.
  startAfterSeconds: number = 0,
): Promise<{
  enqueued: number;
  skipped: number;
  error: string | null;
}> {
  const boss = getGlobalBoss();
  if (!boss) {
    return { enqueued: 0, skipped: 0, error: null };
  }

  try {
    // A live row is a legacy-consolidation candidate when BOTH:
    //   - its `source` is a client/user-writable ingest path
    //     (`APPLE_HEALTH` / `MANUAL` / `IMPORT`) — the only sources that
    //     ever wrote raw per-sample step rows; and
    //   - its `external_id` is NOT already in ANY provider's daily-total
    //     `stats:%` shape (NULL externalId — a manual/legacy row — also
    //     qualifies because `LIKE` against NULL is NULL/false).
    // Both scopes mirror `buildScanWhere` in `consolidate-legacy-steps.ts`
    // so discovery and scan agree exactly. The source pin is what protects
    // WITHINGS (keyed `withings:activity:…`, not `stats:`) and the
    // GOOGLE_HEALTH / FITBIT daily totals (`stats:steps:…`) from the boot
    // sweep that this closes. Splice-free: every literal is a compile-time
    // constant, not user input.
    const users = await dropPendingDeletion(
      prisma,
      await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT DISTINCT m."user_id" AS id
      FROM measurements m
      WHERE m."type" = 'ACTIVITY_STEPS'
        AND m."deleted_at" IS NULL
        AND m."source" IN ('APPLE_HEALTH', 'MANUAL', 'IMPORT')
        AND (
          m."external_id" IS NULL
          OR m."external_id" NOT LIKE 'stats:%'
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
      const payload: StepConsolidationPayload = {
        userId: id,
        enqueuedAt: new Date().toISOString(),
      };
      const jobId = await boss.send(STEP_CONSOLIDATION_QUEUE, payload, {
        retryLimit: 3,
        retryDelay: 60,
        retryBackoff: true,
        singletonKey: `step-consolidation|${id}`,
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
