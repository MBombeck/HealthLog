/**
 * One-time repair of the hourly and daily means a fold computed from part of
 * their window (v1.42).
 *
 * Up to v1.42 the daily-mean consolidation and the dense hourly fold cut at
 * `now - threshold` instead of a local day boundary. A day was folded in two
 * runs, and the second run overwrote the stored mean with the mean of the
 * later part alone: every mean-type day on the night run, and the boundary
 * hour of every dense day (heart rate, HRV, SpO2), plus the derived resting
 * figure of a folded heart-rate day. The folds soft-deleted the samples they
 * took, and a tombstone is kept for 75 days. This pass recomputes such a mean
 * from all of its samples, and only where all of them are provably still in
 * the table.
 *
 * The horizon. A day is repaired only when it starts at or after
 * `foldConstituentHorizon` (`fold-constituents.ts`): every fold tombstone of
 * such a day is younger than the retention, so the live samples plus the
 * fold leftovers are the whole day. For the daily means that is the last 75
 * days; for the dense hourly means, folded 90 days after the fact, the 75
 * days before the raw window. An older day may hold only a fragment of its
 * samples (a re-upload after an anchor reset, the rows of one later run, the
 * v1.28.31 rebuild), and a mean over those can be far off a stored mean that
 * was computed from the full day. Older days are left exactly as they are and
 * counted as `windowsSkippedBeyondHorizon`.
 *
 * Per account, per folded type and source, day by day in `measuredAt` order,
 * over the local days that ended before the fold boundary (`foldBoundary`; a
 * day the fold has not finished is the regular fold's to complete):
 *   - the scan finds the days with fold leftovers (`fold-constituents.ts`; a
 *     person's deletions are left out); a day without any has nothing to
 *     repair and is passed over;
 *   - inside the day's transaction, under the fold lock, the day's live raw
 *     samples and its fold leftovers are read again;
 *   - for each hour (dense) or the day (mean) with a live `stats:` row and at
 *     least one fold leftover, the mean over every sample is compared with the
 *     stored value, and only a different value is written. A window without
 *     leftovers is left alone: its samples in hand are not all of it;
 *   - the live samples of every window it checked are soft-deleted as fold
 *     leftovers (`absorbIntoFold`): they are now part of the stored mean, and
 *     a second run then computes the same mean from the same samples;
 *   - for an Apple Health heart-rate day, the derived resting row is
 *     recomputed from the whole day the same way, when one exists.
 *
 * Concurrency. The day transaction takes the restore lock and then the fold
 * lock (`restore-lock.ts`), which the daily-mean consolidation and the dense
 * fold take too, and reads the day's samples only after that. A fold and the
 * repair therefore never work on one account's means at the same moment, and
 * each sees what the other committed: samples one of them took into a mean
 * are leftovers for the other, never counted twice and never missing.
 *
 * The pass holds one page of rows and one day at a time. It stops between
 * days when the job's budget runs out and sends a follow-up that resumes at
 * the next day; an account under restore is left and retried a few minutes
 * later. Writing only values that differ makes a repeated run a no-op, so
 * the pass is idempotent.
 *
 * When an account is through, a `MeasurementFoldRepair` row records it. The
 * compaction-tombstone purge deletes exactly the tombstones this pass reads,
 * so it leaves an account alone until that row exists, and the repair queues a
 * purge run as it finishes.
 *
 * Reported per run: one outcome per account (`reportJobRun`) and, per type,
 * how many windows were checked, corrected and left beyond the horizon, and
 * how many live samples were taken into a checked mean. Counts only, never a
 * value.
 *
 * The queue name MUST be registered in `allQueues` in
 * `src/lib/jobs/reminder/register-maintenance.ts`, or the sends silently
 * no-op.
 */
import { createHash } from "node:crypto";
import type { Job } from "pg-boss";

import type {
  MeasurementSource,
  MeasurementType,
  PrismaClient,
} from "@/generated/prisma/client";
import { prisma as defaultPrisma } from "@/lib/db";
import {
  AccountRestoreInProgressError,
  holdAccountAgainstRestore,
  holdAccountFoldLock,
} from "@/lib/export/restore-lock";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import {
  COMPACTION_TOMBSTONE_PURGE_QUEUE,
  COMPACTION_TOMBSTONE_PURGE_SINGLETON_KEY,
} from "@/lib/jobs/compaction-tombstone-purge";
import { jobBudget } from "@/lib/jobs/job-budget";
import { jobDone, type JobOutcome } from "@/lib/jobs/job-outcome";
import { reportJobRun, type JobRunCandidate } from "@/lib/jobs/job-run-report";
import { annotate } from "@/lib/logging/context";
import { logCaught } from "@/lib/logging/signal";
import { withBackgroundEvent } from "@/lib/logging/background";
import {
  HIGH_FREQUENCY_MEAN_TYPES,
  dailyStatsExternalId,
  hkIdentifierForType,
} from "@/lib/measurements/apple-health-mapping";
import {
  iterateDayBuckets,
  iterateSourcePages,
  resolveUserTimezone,
} from "@/lib/measurements/consolidation-base";
import {
  CONSOLIDATION_GRACE_CUTOFF_HOURS,
  canonicalDailyTimestamp,
  foldBoundary,
  hourOfDayForUserTz,
} from "@/lib/measurements/consolidation-tz";
import {
  DENSE_INTRADAY_FOLD_SOURCES,
  DENSE_INTRADAY_RETENTION_DAYS,
  DENSE_INTRADAY_RETENTION_TYPES,
  deriveDailyRestingFromPulse,
  hourlyStatsExternalId,
} from "@/lib/measurements/dense-intraday-retention";
import {
  absorbIntoFold,
  foldConstituentHorizon,
  isFoldLeftover,
  loadFoldLeftovers,
  loadLiveSamples,
  meanDiffers,
  meanOf,
  type FoldConstituent,
} from "@/lib/measurements/fold-constituents";
import { recomputeBucketsForMeasurement } from "@/lib/rollups/measurement-rollups";
import { localDayWindow } from "@/lib/tz/local-day";

export const MEASUREMENT_FOLD_REPAIR_QUEUE = "measurement-fold-repair";

/** Delay before the follow-up of a run that stopped early, in seconds. */
export const FOLD_REPAIR_CONTINUATION_DELAY_SECONDS = 30;

/** Delay before retrying an account a restore was holding, in seconds. */
export const FOLD_REPAIR_RESTORE_RETRY_SECONDS = 300;

/** Follow-up runs one account's chain may send. */
export const FOLD_REPAIR_MAX_CONTINUATIONS = 200;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** HealthKit identifier of the derived resting row (`dense-intraday-retention.ts`). */
const RESTING_HK_IDENTIFIER = "HKQuantityTypeIdentifierRestingHeartRate";

/** One (type, source) the folds write means for, and the grain. */
interface RepairStep {
  type: MeasurementType;
  source: MeasurementSource;
  grain: "day" | "hour";
  foldedAfterMs: number;
}

/** Fixed order, so a resume position (`step`) means the same on every run. */
export const FOLD_REPAIR_STEPS: readonly RepairStep[] = [
  ...[...HIGH_FREQUENCY_MEAN_TYPES].map((type): RepairStep => ({
    type,
    source: "APPLE_HEALTH",
    grain: "day",
    foldedAfterMs: CONSOLIDATION_GRACE_CUTOFF_HOURS * HOUR_MS,
  })),
  ...DENSE_INTRADAY_FOLD_SOURCES.flatMap((source) =>
    [...DENSE_INTRADAY_RETENTION_TYPES].map((type): RepairStep => ({
      type,
      source,
      grain: "hour",
      foldedAfterMs: DENSE_INTRADAY_RETENTION_DAYS * DAY_MS,
    })),
  ),
];

export interface FoldRepairResume {
  /** Index into {@link FOLD_REPAIR_STEPS}. */
  step: number;
  /** ISO instant: the step resumes at rows measured at or after it. */
  after?: string;
}

export interface MeasurementFoldRepairPayload {
  userId: string;
  resume?: FoldRepairResume;
  continuation?: number;
}

/** Per-type counts. Never a value. */
export interface FoldRepairTypeCounts {
  /** Hours or days with a live `stats:` row and fold leftovers. */
  windowsChecked: number;
  /** Of those, the ones whose stored mean was corrected. */
  windowsCorrected: number;
  /** Derived resting rows corrected (heart rate only). */
  restingCorrected: number;
  /**
   * Hours or days with fold leftovers on a day before the horizon, left as
   * they are (see the header).
   */
  windowsSkippedBeyondHorizon: number;
  /** Live samples taken into a checked mean and kept as fold leftovers. */
  samplesAbsorbed: number;
}

/** All-zero counts. */
export function emptyFoldRepairCounts(): FoldRepairTypeCounts {
  return {
    windowsChecked: 0,
    windowsCorrected: 0,
    restingCorrected: 0,
    windowsSkippedBeyondHorizon: 0,
    samplesAbsorbed: 0,
  };
}

export interface FoldRepairResult {
  status: "completed" | "stopped" | "restore_in_progress";
  /** Where the next run starts, when `status` is `stopped`. */
  resume?: FoldRepairResume;
  byType: Record<string, FoldRepairTypeCounts>;
  /** Days with fold leftovers inside the horizon the pass looked at. */
  daysWithLeftovers: number;
}

type ScanRow = {
  id: string;
  type: MeasurementType;
  value: number;
  measuredAt: Date;
  externalId: string | null;
  deletedAt: Date | null;
  syncVersion: number;
};

function countsFor(
  result: FoldRepairResult,
  type: MeasurementType,
): FoldRepairTypeCounts {
  let counts = result.byType[type];
  if (!counts) {
    counts = emptyFoldRepairCounts();
    result.byType[type] = counts;
  }
  return counts;
}

/**
 * Repair one account. Resolves with `stopped` and a resume position when
 * `shouldStop` ends the walk between two days, with `restore_in_progress`
 * when a restore of the account holds it, and with `completed` otherwise.
 */
export async function repairFoldedMeans(
  prisma: PrismaClient,
  userId: string,
  options: {
    resume?: FoldRepairResume;
    shouldStop?: () => boolean;
    pageSize?: number;
    /** The instant the horizon and the fold boundary are read against. */
    now?: Date;
  } = {},
): Promise<FoldRepairResult> {
  const result: FoldRepairResult = {
    status: "completed",
    byType: {},
    daysWithLeftovers: 0,
  };
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { timezone: true },
  });
  if (!user) return result;
  const tz = resolveUserTimezone(user.timezone);
  const shouldStop = options.shouldStop ?? (() => false);
  const firstStep = options.resume?.step ?? 0;
  const now = options.now ?? new Date();

  for (
    let stepIndex = firstStep;
    stepIndex < FOLD_REPAIR_STEPS.length;
    stepIndex++
  ) {
    const step = FOLD_REPAIR_STEPS[stepIndex];
    const hk = hkIdentifierForType(step.type);
    if (!hk) continue;

    // Nothing of this type and source was ever folded: no `stats:` row.
    const anyStats = await prisma.measurement.findFirst({
      where: {
        userId,
        type: step.type,
        source: step.source,
        externalId: { startsWith: `stats:${hk}:` },
        deletedAt: null,
      },
      select: { id: true },
    });
    if (!anyStats) continue;
    // Only the local days the fold has finished: a day after the boundary
    // is the regular fold's to complete, from the same samples.
    const upper = foldBoundary(now, step.foldedAfterMs, tz);
    const horizon = foldConstituentHorizon(now, step.foldedAfterMs);
    const after =
      stepIndex === firstStep && options.resume?.after
        ? new Date(options.resume.after)
        : null;

    const pages = iterateSourcePages<ScanRow>(
      prisma,
      {
        userId,
        type: step.type,
        source: step.source,
        externalId: { not: null },
        NOT: [
          { externalId: { startsWith: "stats:" } },
          { externalId: { startsWith: "retired:" } },
        ],
        OR: [{ deletedAt: null }, { deletedAt: { not: null }, syncVersion: 1 }],
        measuredAt: after ? { gte: after, lt: upper } : { lt: upper },
      },
      {
        id: true,
        type: true,
        value: true,
        measuredAt: true,
        externalId: true,
        deletedAt: true,
        syncVersion: true,
      },
      options.pageSize,
    );

    for await (const [dateKey, dayRows] of iterateDayBuckets(pages, tz, null)) {
      if (shouldStop()) {
        result.status = "stopped";
        result.resume = {
          step: stepIndex,
          after: localDayWindow(dateKey, tz).dayStart.toISOString(),
        };
        return result;
      }
      const leftovers = dayRows.filter((row) =>
        isFoldLeftover(row, step.foldedAfterMs),
      );
      if (leftovers.length === 0) continue;
      const window = localDayWindow(dateKey, tz);
      if (window.dayStart < horizon) {
        countsFor(result, step.type).windowsSkippedBeyondHorizon += new Set(
          leftovers.map((row) => windowId(step, hk, dateKey, row, tz)),
        ).size;
        continue;
      }
      result.daysWithLeftovers += 1;
      try {
        await repairDay(prisma, {
          userId,
          tz,
          dateKey,
          window,
          hk,
          step,
          counts: countsFor(result, step.type),
        });
      } catch (err) {
        if (err instanceof AccountRestoreInProgressError) {
          result.status = "restore_in_progress";
          result.resume = {
            step: stepIndex,
            after: localDayWindow(dateKey, tz).dayStart.toISOString(),
          };
          return result;
        }
        throw err;
      }
    }
  }
  return result;
}

/** The `stats:` id of the window a sample belongs to. */
function windowId(
  step: RepairStep,
  hk: string,
  dateKey: string,
  row: { measuredAt: Date },
  tz: string,
): string {
  return step.grain === "day"
    ? dailyStatsExternalId(hk, dateKey)
    : hourlyStatsExternalId(
        hk,
        dateKey,
        hourOfDayForUserTz(row.measuredAt, tz),
      );
}

/**
 * Recompute one day's means from all of its samples; write only differences.
 * The samples are read inside the transaction, under the fold lock.
 */
async function repairDay(
  prisma: PrismaClient,
  input: {
    userId: string;
    tz: string;
    dateKey: string;
    window: { dayStart: Date; dayEnd: Date };
    hk: string;
    step: RepairStep;
    counts: FoldRepairTypeCounts;
  },
): Promise<void> {
  const { userId, tz, dateKey, window, hk, step, counts } = input;

  const restingExternalId =
    step.type === "PULSE" && step.source === "APPLE_HEALTH"
      ? dailyStatsExternalId(
          RESTING_HK_IDENTIFIER,
          // The fold keys the derived row by the UTC date of local noon.
          // eslint-disable-next-line healthlog/no-utc-day-key -- UTC by design: matches the derived resting row's stats: key in dense-intraday-retention.ts
          canonicalDailyTimestamp(dateKey, tz).toISOString().slice(0, 10),
        )
      : null;

  let dayRowChanged: Date | null = null;
  let checked = 0;
  let corrected = 0;
  let resting = 0;
  let absorbed = 0;
  await prisma.$transaction(async (tx) => {
    // First, before any reading is touched: see `restore-lock.ts`.
    await holdAccountAgainstRestore(tx, userId);
    // The folds rewrite the same rows; one of the two at a time.
    await holdAccountFoldLock(tx, userId);
    const span = {
      userId,
      type: step.type,
      source: step.source,
      from: window.dayStart,
      to: window.dayEnd,
    };
    const live = await loadLiveSamples(tx, span);
    const leftovers = await loadFoldLeftovers(tx, {
      ...span,
      foldedAfterMs: step.foldedAfterMs,
    });
    if (leftovers.length === 0) return;

    // Window id → its samples. Only a window with a fold leftover is
    // checked: one without has no record of what its stored mean was taken
    // from beyond the rows in hand.
    const byWindow = new Map<
      string,
      { values: number[]; liveIds: string[]; leftovers: number }
    >();
    const add = (row: FoldConstituent, isLive: boolean) => {
      const id = windowId(step, hk, dateKey, row, tz);
      let entry = byWindow.get(id);
      if (!entry) {
        entry = { values: [], liveIds: [], leftovers: 0 };
        byWindow.set(id, entry);
      }
      entry.values.push(row.value);
      if (isLive) entry.liveIds.push(row.id);
      else entry.leftovers += 1;
    };
    for (const row of live) add(row, true);
    for (const row of leftovers) add(row, false);

    const stored = await tx.measurement.findMany({
      where: {
        userId,
        type: step.type,
        source: step.source,
        externalId: {
          in: [...byWindow.entries()]
            .filter(([, entry]) => entry.leftovers > 0)
            .map(([id]) => id),
        },
        deletedAt: null,
      },
      select: { id: true, externalId: true, value: true, measuredAt: true },
    });
    const takeIds: string[] = [];
    for (const row of stored) {
      const entry = row.externalId ? byWindow.get(row.externalId) : undefined;
      if (!entry) continue;
      checked += 1;
      takeIds.push(...entry.liveIds);
      if (entry.liveIds.length > 0 && step.grain === "day") {
        dayRowChanged = row.measuredAt;
      }
      const mean = meanOf(entry.values);
      if (!meanDiffers(row.value, mean)) continue;
      await tx.measurement.update({
        where: { id: row.id },
        data: { value: mean, syncVersion: { increment: 1 } },
      });
      corrected += 1;
      if (step.grain === "day") dayRowChanged = row.measuredAt;
    }
    absorbed = await absorbIntoFold(tx, takeIds);

    if (restingExternalId) {
      const restingRow = await tx.measurement.findFirst({
        where: {
          userId,
          type: "RESTING_HEART_RATE",
          source: "COMPUTED",
          externalId: restingExternalId,
          deletedAt: null,
        },
        select: { id: true, value: true },
      });
      const derived = restingRow
        ? deriveDailyRestingFromPulse(
            [...live, ...leftovers].map((row) => ({
              id: row.id,
              type: step.type,
              value: row.value,
              measuredAt: row.measuredAt,
              externalId: null,
            })),
          )
        : null;
      if (restingRow && derived !== null && restingRow.value !== derived) {
        await tx.measurement.update({
          where: { id: restingRow.id },
          data: { value: derived, syncVersion: { increment: 1 } },
        });
        resting += 1;
      }
    }
  });
  counts.windowsChecked += checked;
  counts.windowsCorrected += corrected;
  counts.restingCorrected += resting;
  counts.samplesAbsorbed += absorbed;

  // A daily mean is the only live row of its day once its samples are taken
  // in, so the DAY rollup follows it as the consolidation's own recompute
  // does. The dense tier's DAY bucket was taken from the raw day before the
  // fold and is left alone.
  if (dayRowChanged !== null) {
    await recomputeBucketsForMeasurement(userId, step.type, dayRowChanged);
  }
}

/** Record that the repair has been through an account. */
export async function markFoldRepairComplete(
  prisma: PrismaClient,
  userId: string,
  at: Date = new Date(),
): Promise<void> {
  await prisma.measurementFoldRepair.upsert({
    where: { userId },
    create: { userId, completedAt: at },
    update: { completedAt: at },
  });
}

/** A stable, non-identifying key for one account in the run report. */
function accountKey(userId: string): string {
  return createHash("sha256").update(userId).digest("hex").slice(0, 12);
}

/**
 * One run per account. A finished account gets its marker and queues a purge
 * run; one the budget stopped sends its own follow-up; one under restore is
 * tried again a few minutes later.
 */
export async function handleMeasurementFoldRepair(
  jobs: Job<MeasurementFoldRepairPayload>[],
  prisma: PrismaClient = defaultPrisma,
): Promise<JobOutcome> {
  const shouldStop = jobBudget(jobs);
  return withBackgroundEvent("job.measurement_fold_repair", async (evt) => {
    const startedAt = Date.now();
    const candidates: JobRunCandidate[] = [];
    const totals = {
      checked: 0,
      corrected: 0,
      resting: 0,
      skipped: 0,
      absorbed: 0,
      completed: 0,
    };
    const byType: Record<string, FoldRepairTypeCounts> = {};
    const boss = getGlobalBoss();

    for (const job of jobs) {
      const userId = job.data?.userId;
      if (!userId) continue;
      const continuation = job.data?.continuation ?? 0;
      let result: FoldRepairResult;
      try {
        result = await repairFoldedMeans(prisma, userId, {
          resume: job.data?.resume,
          shouldStop,
        });
      } catch (err) {
        // On the run report as `failed` (which raises `job.run.failed` /
        // `job.run.partial`), with the cause logged here. The next boot
        // retries the account, its marker still absent.
        logCaught("measurement.fold_repair.failed", err);
        candidates.push({
          key: accountKey(userId),
          outcome: "failed",
          cause: "repair_error",
        });
        continue;
      }
      for (const [type, counts] of Object.entries(result.byType)) {
        const sum = (byType[type] ??= emptyFoldRepairCounts());
        sum.windowsChecked += counts.windowsChecked;
        sum.windowsCorrected += counts.windowsCorrected;
        sum.restingCorrected += counts.restingCorrected;
        sum.windowsSkippedBeyondHorizon += counts.windowsSkippedBeyondHorizon;
        sum.samplesAbsorbed += counts.samplesAbsorbed;
        totals.checked += counts.windowsChecked;
        totals.corrected += counts.windowsCorrected;
        totals.resting += counts.restingCorrected;
        totals.skipped += counts.windowsSkippedBeyondHorizon;
        totals.absorbed += counts.samplesAbsorbed;
      }

      if (result.status === "completed") {
        await markFoldRepairComplete(prisma, userId);
        totals.completed += 1;
        candidates.push({ key: accountKey(userId), outcome: "ok" });
        continue;
      }
      candidates.push({
        key: accountKey(userId),
        outcome: "deferred",
        cause:
          result.status === "stopped" ? "job_budget" : "restore_in_progress",
      });
      if (boss && continuation < FOLD_REPAIR_MAX_CONTINUATIONS) {
        const payload: MeasurementFoldRepairPayload = {
          userId,
          resume: result.resume,
          continuation: continuation + 1,
        };
        await boss.send(MEASUREMENT_FOLD_REPAIR_QUEUE, payload, {
          singletonKey: foldRepairSingletonKey(userId),
          startAfter:
            result.status === "stopped"
              ? FOLD_REPAIR_CONTINUATION_DELAY_SECONDS
              : FOLD_REPAIR_RESTORE_RETRY_SECONDS,
          retryLimit: 2,
          retryDelay: 60,
        });
      } else {
        evt.addWarning(
          "measurement-fold-repair stopped an account without a follow-up; the next boot resumes it",
        );
      }
    }

    // A finished account unblocks its share of the purge; one queued run
    // covers every account finished so far.
    if (boss && totals.completed > 0) {
      await boss.send(
        COMPACTION_TOMBSTONE_PURGE_QUEUE,
        { continuation: 0 },
        {
          singletonKey: COMPACTION_TOMBSTONE_PURGE_SINGLETON_KEY,
          startAfter: FOLD_REPAIR_CONTINUATION_DELAY_SECONDS,
          retryLimit: 0,
        },
      );
    }

    await reportJobRun({
      queue: MEASUREMENT_FOLD_REPAIR_QUEUE,
      runId: jobs[0]?.id ?? "unknown",
      candidates,
    });
    annotate({ meta: { fold_repair_by_type: byType } });
    evt.addMeta("fold_repair_means_checked", totals.checked);
    evt.addMeta("fold_repair_means_corrected", totals.corrected);
    evt.addMeta("fold_repair_resting_corrected", totals.resting);
    evt.addMeta("fold_repair_skipped_beyond_horizon", totals.skipped);
    evt.addMeta("fold_repair_samples_absorbed", totals.absorbed);

    return jobDone({
      means_checked: totals.checked,
      means_corrected: totals.corrected,
      resting_corrected: totals.resting,
      means_skipped_beyond_horizon: totals.skipped,
      means_samples_absorbed: totals.absorbed,
      accounts_completed: totals.completed,
      duration_ms: Date.now() - startedAt,
    });
  });
}

/** One key per account, so a boot's send collapses into a queued run. */
export function foldRepairSingletonKey(userId: string): string {
  return `measurement-fold-repair|${userId}`;
}

/**
 * Queue one repair run for every account the repair has not been through.
 * Converges: a finished account has its marker and drops out. Best-effort:
 * errors come back in the result so worker boot never fails on it.
 */
export async function enqueueBootTimeMeasurementFoldRepair(
  prisma: PrismaClient = defaultPrisma,
): Promise<{ enqueued: number; skipped: number; error: string | null }> {
  const boss = getGlobalBoss();
  if (!boss) return { enqueued: 0, skipped: 0, error: null };
  try {
    const users = await prisma.user.findMany({
      where: { measurementFoldRepair: null },
      select: { id: true },
    });
    let enqueued = 0;
    let skipped = 0;
    for (const { id } of users) {
      const payload: MeasurementFoldRepairPayload = { userId: id };
      const jobId = await boss.send(MEASUREMENT_FOLD_REPAIR_QUEUE, payload, {
        singletonKey: foldRepairSingletonKey(id),
        retryLimit: 2,
        retryDelay: 60,
      });
      if (jobId) enqueued += 1;
      else skipped += 1;
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

/** Queue a repair run for one account, e.g. after a restore reset its marker. */
export async function enqueueMeasurementFoldRepair(
  userId: string,
): Promise<boolean> {
  const boss = getGlobalBoss();
  if (!boss) return false;
  const payload: MeasurementFoldRepairPayload = { userId };
  const id = await boss.send(MEASUREMENT_FOLD_REPAIR_QUEUE, payload, {
    singletonKey: foldRepairSingletonKey(userId),
    retryLimit: 2,
    retryDelay: 60,
  });
  return id !== null;
}
