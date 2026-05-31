/**
 * v1.5.6 — consolidate pre-v1.5.0 legacy step rows into one daily-total
 * row per user per calendar day.
 *
 * Pre-v1.5.0, HealthKit step samples landed at sampling granularity —
 * hundreds-to-thousands of `ACTIVITY_STEPS` rows per day. Post-v1.5.0,
 * iOS emits one overwrite-able daily-total row carrying the
 * `stats:HKQuantityTypeIdentifierStepCount:YYYY-MM-DD` externalId
 * (see `src/app/api/measurements/batch/route.ts` stats-overwrite logic).
 * This pass collapses the legacy granular rows into the same canonical
 * daily shape so historical step data reads consistently.
 *
 * Per user × calendar day (anchored to `User.timezone`):
 *   1. SELECT live (`deletedAt IS NULL`) `ACTIVITY_STEPS` rows whose
 *      `externalId` does NOT start with the daily-stats prefix.
 *   2. Group into per-day buckets in the user's timezone.
 *   3. SUM the legacy values for the day.
 *   4. UPSERT the canonical daily-total row keyed by
 *      `stats:HKQuantityTypeIdentifierStepCount:<dateKey>`. If a daily
 *      total already exists for the day (post-v1.5.0 iOS already wrote
 *      one), the existing total is the source of truth — it is NOT
 *      overwritten and the legacy sum is NOT folded in (avoids double-
 *      counting: the post-v1.5.0 row already represents the true daily
 *      total HealthKit computed). The legacy granular rows are still
 *      soft-deleted so they stop polluting the per-sample read path.
 *   5. SOFT-DELETE (set `deletedAt`) the legacy granular rows — they
 *      stay in the table as an audit/backup trail. Sampling-granularity
 *      loss is explicitly accepted.
 *
 * Idempotent: the discovery query (`enqueueBootTimeStepConsolidation`)
 * matches only users still holding live legacy step rows, so a second
 * run converges to zero work. Within a run, soft-deleted legacy rows
 * are excluded from the scan, so a re-run after a partial pass never
 * re-aggregates an already-consolidated day.
 *
 * Runs on pg-boss (`STEP_CONSOLIDATION_QUEUE`), not a CLI — the
 * production standalone image strips `tsx`. Modelled on the
 * `rollup-full-backfill` boot-time converging-backfill pattern.
 */
import type { PrismaClient } from "@/generated/prisma/client";

import { dailyStatsExternalId } from "./apple-health-mapping";
import {
  bucketRowsByDay,
  runConsolidation,
  type DayWriteOutcome,
} from "./consolidation-base";
import { type PerSampleRow } from "./drain-per-sample-cumulative";

/** HealthLog measurement type that carries step counts. */
const STEP_TYPE = "ACTIVITY_STEPS" as const;

/** Canonical HealthKit identifier for the step type. */
const STEP_HK_IDENTIFIER = "HKQuantityTypeIdentifierStepCount";

/**
 * Daily-total externalId prefix. Legacy rows that do NOT start with
 * this are candidates for consolidation; the daily-total row this pass
 * mints carries the full `stats:HKQuantityTypeIdentifierStepCount:<day>`
 * externalId.
 */
export const STEP_DAILY_STATS_PREFIX = `stats:${STEP_HK_IDENTIFIER}:`;

/** Per-(user, day) action summary. */
export interface StepConsolidationBucket {
  userId: string;
  /** Calendar-day key in the user's timezone (`YYYY-MM-DD`). */
  dateKey: string;
  /** Number of legacy granular rows folded for this day. */
  legacyRowCount: number;
  /** SUM of the legacy granular values for the day. */
  legacySum: number;
  /** Whether a `stats:` daily total already existed for this day. */
  hadExistingTotal: boolean;
  /** ISO-8601 canonical timestamp (local-noon of the user's day). */
  canonicalTimestamp: string;
  /** Resulting daily-total `externalId`. */
  externalId: string;
}

export interface StepConsolidationSummary {
  /** Did the run actually write to the DB (false for `dryRun`). */
  dryRun: boolean;
  /** Per-user-day buckets the pass rewrote (or would rewrite). */
  buckets: StepConsolidationBucket[];
  totals: {
    usersScanned: number;
    daysConsolidated: number;
    legacyRowsSoftDeleted: number;
    dailyRowsUpserted: number;
    /** Days skipped because a `stats:` total already existed. */
    daysFoldedIntoExisting: number;
    /**
     * Days skipped because the per-day mint hit a unique-constraint
     * collision (P2002) and the transaction rolled back. Counted, logged,
     * and stepped over so a single poison day can never strand the rest
     * of the pass — the pass stays converging for every other day.
     */
    daysSkippedOnConflict: number;
  };
}

/** True for a Prisma unique-constraint violation (P2002). */
function isUniqueConstraintViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "P2002"
  );
}

export interface StepConsolidationOptions {
  /** Limit the pass to a single user. Default = every user. */
  userId?: string;
  /** Preview-only mode — no DB writes. */
  dryRun?: boolean;
  /** Logger sink — defaults to `console.log`. */
  log?: (line: string) => void;
}

/**
 * Group legacy step rows into per-day buckets in the user's timezone.
 * Rows already in the daily-stats shape are skipped — they are the
 * canonical total, not a legacy sample. Exposed for unit testing the
 * bucketing semantics without booting Prisma.
 */
export function bucketLegacyStepRows(
  rows: readonly PerSampleRow[],
  tz: string,
): Map<string, PerSampleRow[]> {
  return bucketRowsByDay(rows, tz, STEP_DAILY_STATS_PREFIX);
}

/** SUM the values in a per-day legacy bucket. */
export function sumLegacyStepValues(rows: readonly PerSampleRow[]): number {
  let acc = 0;
  for (const row of rows) acc += row.value;
  return acc;
}

/**
 * Run the step consolidation. Idempotent — re-invocation after a
 * successful pass reports zero days consolidated because the legacy
 * rows are soft-deleted (and so excluded from the live scan).
 *
 * Does NOT enforce any auth gate — the queue handler owns that concern.
 */
export async function consolidateLegacySteps(
  prismaClient: PrismaClient,
  options: StepConsolidationOptions = {},
): Promise<StepConsolidationSummary> {
  const log = options.log ?? ((line) => console.log(line));

  const summary: StepConsolidationSummary = {
    dryRun: options.dryRun ?? false,
    buckets: [],
    totals: {
      usersScanned: 0,
      daysConsolidated: 0,
      legacyRowsSoftDeleted: 0,
      dailyRowsUpserted: 0,
      daysFoldedIntoExisting: 0,
      daysSkippedOnConflict: 0,
    },
  };

  // Per-user day count for the COMPLETE log line (mirrors `byDay.size`).
  // Single type, so the per-(user, type) scan is the per-user scan.
  // `perUserScanned` gates the START + COMPLETE log pair so a user with
  // zero live legacy rows logs nothing, exactly as the prior loop's
  // `if (legacyRows.length === 0) continue` did.
  let perUserDayCount = 0;
  let perUserScanned = false;

  const { usersScanned } = await runConsolidation<typeof STEP_TYPE>({
    prismaClient,
    options,
    types: [STEP_TYPE],
    // Single type — the HK identifier is fixed.
    hkIdentifierForType: () => STEP_HK_IDENTIFIER,
    dailyStatsExternalId,
    statsPrefix: STEP_DAILY_STATS_PREFIX,
    reduce: sumLegacyStepValues,
    // Live legacy step rows whose externalId is NOT the daily-stats
    // shape. The `stats:` daily-total row (if present) is read separately
    // per day; we exclude it here so it is never soft-deleted. No
    // source-scope — legacy granular rows predate the source split, so
    // every source is in scope. Soft-deleted rows are excluded so a
    // re-run after a partial pass never re-aggregates.
    buildScanWhere: ({ userId, type, statsPrefix }) => ({
      userId,
      type,
      deletedAt: null,
      NOT: { externalId: { startsWith: statsPrefix } },
    }),
    // Does a post-v1.5.0 daily total already exist for this day? If so it
    // is the source of truth (HealthKit's own daily aggregate) — we do
    // NOT overwrite it and do NOT add the legacy sum on top (that would
    // double-count). We still soft-delete the legacy rows. `source` is
    // deliberately omitted from this probe (the write below pins
    // `source: "MANUAL"`): a daily total written by iOS lands as
    // `APPLE_HEALTH`, and matching it here is what prevents minting a
    // second MANUAL total on top of it. The asymmetry with the upsert
    // `where` is intentional, not a bug. Returning `false` records the
    // bucket but skips the mint.
    onBucket: async ({ prismaClient: pc, userId, type, externalId }) => {
      const existingTotal = await pc.measurement.findFirst({
        where: { userId, type, externalId, deletedAt: null },
        select: { id: true },
      });
      return existingTotal === null; // shouldMint
    },
    writeDay: async ({
      prismaClient: pc,
      userId,
      type,
      externalId,
      canonicalTimestamp,
      reducedValue,
      sourceRowIds,
      shouldMint,
    }): Promise<DayWriteOutcome> => {
      try {
        let removed = 0;
        await pc.$transaction(async (tx) => {
          if (shouldMint) {
            // Mint the canonical daily-total row. The unique index
            // (userId, type, source, externalId) makes the upsert
            // idempotent across re-runs. Source is MANUAL — these are
            // historical rows whose original sampling source is no longer
            // meaningful once collapsed; the externalId carries the
            // canonical daily-stats shape. Built field-by-field (no
            // spread) per the no-mass-assignment convention.
            await tx.measurement.upsert({
              where: {
                userId_type_source_externalId: {
                  userId,
                  type,
                  source: "MANUAL",
                  externalId,
                },
              },
              create: {
                userId,
                type,
                value: reducedValue,
                unit: "steps",
                source: "MANUAL",
                measuredAt: canonicalTimestamp,
                externalId,
              },
              update: {
                value: reducedValue,
                measuredAt: canonicalTimestamp,
                deletedAt: null,
              },
            });
          }

          // Soft-delete the legacy granular rows in the same transaction.
          // Tombstone, never hard-delete — they remain as an audit/backup
          // trail. `deletedAt` excludes them from every live read and from
          // this pass's own re-run discovery.
          const del = await tx.measurement.updateMany({
            where: { id: { in: sourceRowIds }, deletedAt: null },
            data: { deletedAt: new Date() },
          });
          removed = del.count;
        });
        return { kind: "written", sourceRowsRemoved: removed };
      } catch (err) {
        // A pre-existing row can collide on the second unique index
        // (userId, type, measuredAt, source, sleepStage) when a MANUAL
        // step row already sits at this day's canonical-noon instant with
        // a null externalId — the mint's `create` branch fires (the
        // upsert keys on externalId, which differs) and trips that index,
        // rolling back the soft-delete too. Skipping the day (rather than
        // aborting the whole user) keeps the pass converging: the legacy
        // rows stay live but every other day still consolidates, and the
        // run does not re-throw on every boot. Non-P2002 errors are
        // genuine failures — rethrow so pg-boss retries.
        if (!isUniqueConstraintViolation(err)) throw err;
        return { kind: "skipped-conflict" };
      }
    },
    recordBucket: ({
      userId,
      dateKey,
      dayRows,
      reducedValue,
      canonicalTimestamp,
      externalId,
      shouldMint,
      outcome,
    }) => {
      const dryRun = outcome === null;
      if (outcome?.kind === "skipped-conflict") {
        // Mint hit a unique-constraint collision; the transaction rolled
        // back. Step over the day — record only the skip counter.
        summary.totals.daysSkippedOnConflict += 1;
        log(
          `[step-consolidation] user=${userId} day=${dateKey} skipped — unique-constraint conflict on mint`,
        );
        return;
      }

      const hadExistingTotal = !shouldMint;
      summary.buckets.push({
        userId,
        dateKey,
        legacyRowCount: dayRows.length,
        legacySum: reducedValue,
        hadExistingTotal,
        canonicalTimestamp: canonicalTimestamp.toISOString(),
        externalId,
      });
      summary.totals.daysConsolidated += 1;
      if (hadExistingTotal) summary.totals.daysFoldedIntoExisting += 1;
      if (shouldMint) summary.totals.dailyRowsUpserted += 1;
      // Real run: count what the transaction soft-deleted. Dry-run: count
      // the rows that would have been soft-deleted.
      summary.totals.legacyRowsSoftDeleted +=
        outcome?.kind === "written" && !dryRun
          ? outcome.sourceRowsRemoved
          : dayRows.length;
    },
    onScan: ({ userId, tz, rowCount, dayCount, dryRun }) => {
      perUserDayCount = dayCount;
      perUserScanned = true;
      log(
        `[step-consolidation] user=${userId} tz=${tz} legacyRows=${rowCount}${dryRun ? " (dry-run)" : ""}`,
      );
    },
    onUserComplete: ({ userId, dryRun }) => {
      // Skip the COMPLETE line for users with no live legacy rows — the
      // scan never fired, matching the prior zero-row `continue`.
      if (perUserScanned) {
        log(
          `[step-consolidation] user=${userId} complete days=${perUserDayCount}${dryRun ? " (dry-run)" : ""}`,
        );
      }
      perUserDayCount = 0;
      perUserScanned = false;
    },
  });

  summary.totals.usersScanned = usersScanned;

  log(
    `[step-consolidation] done — usersScanned=${summary.totals.usersScanned} daysConsolidated=${summary.totals.daysConsolidated} legacyRowsSoftDeleted=${summary.totals.legacyRowsSoftDeleted} dailyRowsUpserted=${summary.totals.dailyRowsUpserted} daysFoldedIntoExisting=${summary.totals.daysFoldedIntoExisting} daysSkippedOnConflict=${summary.totals.daysSkippedOnConflict}${options.dryRun ? " (dry-run)" : ""}`,
  );

  return summary;
}
