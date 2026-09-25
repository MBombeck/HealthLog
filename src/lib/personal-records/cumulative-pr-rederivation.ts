/**
 * v1.30.3 (QA F4) — one-shot repair for the `PersonalRecord` rows the
 * pre-fix cumulative-day picker double-counted.
 *
 * Background: before `8902d3985` (v1.29.6), `findBestCumulativeDay`
 * (`pr-detection-worker.ts`) summed EVERY row on a calendar day regardless
 * of source — a day with both an Apple Health AND a Withings write for the
 * same cumulative metric (steps, active energy, flights, distance,
 * daylight, falls) summed both sources into one inflated total and wrote
 * it as the all-time "best". The fix (source-collapse via
 * `pickCanonicalSourceRows` before summing) stops the inflation going
 * forward, but the worker's improvement gate only ever compares a
 * freshly-computed day against the STORED best — an already-inflated
 * stored row can never be beaten again, so the false record silently
 * outranks every honest day forever (PR list, digest milestone, doctor
 * report), and the affected user can never set a genuine record on that
 * metric again.
 *
 * This job deletes the suspect rows (measurement-driven — `metricSlot`
 * null — one of `CUMULATIVE_HK_TYPES`, created BEFORE the fix landed) and
 * immediately re-runs detection for the affected user with `silent: true`
 * so the (already-fixed) worker inserts the honest re-derived best without
 * firing a "new record" push for what is data hygiene, not an achievement.
 *
 * Converges to zero without a marker column: the cutoff is the fixed
 * instant the source-collapse fix went live upstream (safely after the
 * `8902d3985` merge). Any row created before it predates the bug fix and
 * is suspect; any row this job (or the ordinary worker) writes going
 * forward is always created after that instant, so it can never re-match
 * the discovery predicate. A re-run (reboot mid-walk, or an install that
 * upgrades straight past this release) simply finds fewer/no affected
 * users each time.
 *
 * The queue name MUST be registered in `allQueues` in
 * `src/lib/jobs/reminder/register-rollup.ts` or pg-boss never provisions
 * it and the boot enqueue silently never drains (the v1.4.37 dead-queue
 * class).
 */
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import { CUMULATIVE_HK_TYPES } from "@/lib/measurements/apple-health-mapping";
import { detectPersonalRecordsForUser } from "@/lib/personal-records/pr-detection-worker";
import type { MeasurementType, PrismaClient } from "@/generated/prisma/client";

/** Budget for one account's delete-and-re-derive transaction. */
const REDERIVE_TRANSACTION_TIMEOUT_MS = 5 * 60 * 1000;

export const CUMULATIVE_PR_REDERIVE_QUEUE = "cumulative-pr-rederive";

/**
 * Serial concurrency — a repair walks one account's PersonalRecord rows
 * and re-runs full detection; matches the other one-shot repair jobs
 * (`STEP_CONSOLIDATION_REPAIR_CONCURRENCY`).
 */
export const CUMULATIVE_PR_REDERIVE_CONCURRENCY = 1;

/**
 * The instant the cumulative-day source-collapse fix (`8902d3985`,
 * v1.29.6) went live. Any measurement-driven `PersonalRecord` row for a
 * cumulative type `createdAt` STRICTLY BEFORE this instant was written by
 * the pre-fix multi-source SUM and is suspect. Hardcoded (not derived from
 * git/commit metadata at runtime) so the predicate is a compile-time
 * constant every self-hosted install evaluates identically regardless of
 * when it upgrades to this release.
 */
export const CUMULATIVE_PR_FIX_CUTOFF = new Date("2026-07-18T00:00:00.000Z");

const CUMULATIVE_TYPES_ARRAY: MeasurementType[] = [
  ...CUMULATIVE_HK_TYPES,
] as MeasurementType[];

export interface CumulativePrRederivePayload {
  userId: string;
  enqueuedAt: string;
}

export interface CumulativePrRederiveSummary {
  /** Suspect rows deleted for this user. */
  rowsDeleted: number;
  /** Records the (already-fixed) worker re-inserted after the delete. */
  rowsReinserted: number;
}

/**
 * Per-user repair handler. Deletes the suspect measurement-driven
 * cumulative-type `PersonalRecord` rows for `userId`, then re-runs
 * detection silently so the honest re-derived best (if any — the warm-up
 * gate can still apply) replaces it. Safe to re-run: a second pass finds
 * zero suspect rows once the honest one has replaced them (its
 * `createdAt` is always after the cutoff).
 */
export async function runCumulativePrRederivationForUser(
  userId: string,
): Promise<CumulativePrRederiveSummary> {
  // One transaction: the suspect rows go and the re-derived ones arrive
  // together, or neither happens. Deleting first and re-deriving after the
  // commit lost the records whenever the detector failed (a timeout on a
  // large account, a restart): discovery looks for the suspect rows, so once
  // they were gone the account was never repaired again (#1031). The detector
  // reads through the transaction, so it sees the suspect rows as deleted and
  // compares against what is left. It only reads and inserts, and sends no
  // notification when `silent`.
  const { rowsDeleted, rowsReinserted } = await prisma.$transaction(
    async (tx) => {
      const { count } = await tx.personalRecord.deleteMany({
        where: {
          userId,
          metricSlot: null,
          metricType: { in: CUMULATIVE_TYPES_ARRAY },
          createdAt: { lt: CUMULATIVE_PR_FIX_CUTOFF },
        },
      });
      if (count === 0) return { rowsDeleted: 0, rowsReinserted: 0 };
      const result = await detectPersonalRecordsForUser(userId, {
        silent: true,
        prisma: tx as unknown as PrismaClient,
      });
      return {
        rowsDeleted: count,
        rowsReinserted: result.inserted + result.ties,
      };
    },
    // The detector walks every trackable type of the account; on a large
    // record that is tens of seconds (19.8 s measured for 1.25 million
    // measurements plus 784 000 energy rows), so the default five seconds
    // would roll back every repair that matters.
    { timeout: REDERIVE_TRANSACTION_TIMEOUT_MS, maxWait: 10_000 },
  );

  annotate({
    action: {
      name: "personal-record.cumulative.rederive",
      details: { rows_deleted: rowsDeleted, rows_reinserted: rowsReinserted },
    },
  });

  return { rowsDeleted, rowsReinserted };
}

/**
 * Boot-time discovery. Finds every account still holding a suspect
 * measurement-driven cumulative-type `PersonalRecord` row (created before
 * the fix cutoff) and enqueues one repair job per account.
 *
 * Self-converging: once a suspect row is deleted and (when the warm-up
 * gate clears) replaced by an honestly re-derived one, its `createdAt`
 * sits after the cutoff and the account drops off the discovery list for
 * good. Best-effort: errors return through the result so worker boot never
 * fails on a repair miss.
 */
export async function enqueueBootTimeCumulativePrRederivation(
  startAfterSeconds: number = 0,
): Promise<{ enqueued: number; skipped: number; error: string | null }> {
  const boss = getGlobalBoss();
  if (!boss) {
    return { enqueued: 0, skipped: 0, error: null };
  }

  try {
    const affected = await prisma.personalRecord.findMany({
      where: {
        metricSlot: null,
        metricType: { in: CUMULATIVE_TYPES_ARRAY },
        createdAt: { lt: CUMULATIVE_PR_FIX_CUTOFF },
      },
      distinct: ["userId"],
      select: { userId: true },
    });

    if (affected.length === 0) {
      return { enqueued: 0, skipped: 0, error: null };
    }

    let enqueued = 0;
    let skipped = 0;
    for (const { userId } of affected) {
      const payload: CumulativePrRederivePayload = {
        userId,
        enqueuedAt: new Date().toISOString(),
      };
      const jobId = await boss.send(CUMULATIVE_PR_REDERIVE_QUEUE, payload, {
        retryLimit: 3,
        retryDelay: 60,
        retryBackoff: true,
        // Coalesce: if a repair for this user is already queued and we
        // restart, pg-boss returns null instead of duplicating.
        singletonKey: `cumulative-pr-rederive|${userId}`,
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
