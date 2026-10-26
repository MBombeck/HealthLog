/**
 * Nightly rebuild of the mood forecast rows.
 *
 * **This is not an AI surface.** A ridge regression over a dozen standardised
 * columns is arithmetic: no provider, no key, no egress, no consent gate. It
 * is stated here because the shape of the feature invites the assumption in
 * both directions — nobody should wire a consent check that does not apply,
 * and nobody should assume one exists where none is needed. If a later change
 * narrates this forecast through a language model, THAT call site inherits
 * `ai-consent-enforcement-guard.test.ts` and has to declare its surface.
 *
 * **This file is the only writer of `MoodPrediction`**, held there by
 * `src/__tests__/mood-prediction-write-surface-guard.test.ts`. The reason is
 * the product rule: a day carries the person's own rating and the value their
 * past days imply, the two are never merged, and the second one is not
 * editable. A route that wrote this table would make it editable. The cycle
 * module learned the other half of the same lesson the expensive way — a
 * forecast written as a side effect of opening a page is a function of
 * browsing rather than of data.
 *
 * **A pass replaces; it never accumulates.** Every account it touches ends the
 * pass holding exactly the rows this run wrote, or none. An account that has
 * fallen below the threshold, switched the module off, or stopped showing a
 * pattern is left with nothing rather than with last week's answer under a
 * fresh-looking date. That is the stale rule, chosen over marking rows
 * superseded because a derived row is cheap to rebuild and a superseded row is
 * one more state every reader has to handle correctly.
 *
 * Runs at 04:35 Europe/Berlin. The 03:xx block is retention; 04:10 is the
 * document purge, 04:20 the cycle forecast, 04:25 the achievement sweep, 04:30
 * the insight pre-generation, and 04:45/50/55 the recovery, stress and strain
 * scores. 04:35 is free, and it sits after the inputs this job reads have
 * settled. (04:40 is not free: the geo backfill runs at `40 * * * *`.)
 */
import { OWNED_BY_ACTIVE_ACCOUNT } from "@/lib/account-deletion/active-account";
import type { Job } from "pg-boss";

import {
  computeForecast,
  type ForecastRefusal,
} from "@/lib/analytics/mood-prognosis/forecast";
import {
  PROGNOSIS_FIT_WINDOW_DAYS,
  dayKeyBefore,
  loadPrognosisDays,
} from "@/lib/analytics/mood-prognosis/load";
import { MIN_ENTRIES_FOR_FORECAST } from "@/lib/analytics/mood-prognosis/thresholds";
import { jobDone, jobFailed, type JobOutcome } from "@/lib/jobs/job-outcome";
import { withBackgroundEvent } from "@/lib/logging/background";
import { isModuleEnabled } from "@/lib/modules/gate";

import { getWorkerPrisma } from "./reminder/shared";

export interface MoodPrognosisRefreshPayload {
  triggeredAt: string;
}

export interface MoodPrognosisRefreshSummary {
  /** Accounts the cohort query returned, plus any holding stale rows. */
  scanned: number;
  /** Accounts whose forecast rows now reflect their data. */
  refreshed: number;
  /** Rows written across every account. */
  rowsWritten: number;
  /** Accounts the fit refused, whose rows were cleared. */
  refused: number;
  /** Accounts whose module is off, whose rows were cleared. */
  moduleOff: number;
  /** Accounts whose pass threw. */
  failed: number;
}

/**
 * Rebuild one account's rows, or clear them.
 *
 * The write and the delete are the two calls the guard allows in this file,
 * and they are here rather than beside the arithmetic so the single-writer
 * claim is a property of one module rather than a convention across two.
 */
async function refreshAccount(
  userId: string,
  now: Date,
): Promise<{ rows: number; refusal: ForecastRefusal | null }> {
  const prisma = getWorkerPrisma();
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { timezone: true },
  });
  const days = await loadPrognosisDays(userId, now, user?.timezone ?? null);
  const result = computeForecast(days);

  if (result.status === "refused") {
    await prisma.moodPrediction.deleteMany({ where: { userId } });
    return { rows: 0, refusal: result.reason };
  }

  const written: string[] = [];
  for (const row of result.rows) {
    const data = {
      predicted: row.predicted,
      ciLow: row.ciLow,
      ciHigh: row.ciHigh,
      n: row.n,
      modelVersion: row.modelVersion,
      features: JSON.stringify(row.contributions),
      computedAt: now,
    };
    await prisma.moodPrediction.upsert({
      where: { userId_date: { userId, date: row.date } },
      create: { userId, date: row.date, ...data },
      update: data,
    });
    written.push(row.date);
  }
  // Everything outside this pass goes, so no account holds a row from an older
  // fit beside a row from this one.
  await prisma.moodPrediction.deleteMany({
    where: { userId, date: { notIn: written } },
  });
  return { rows: written.length, refusal: null };
}

/**
 * Refresh every eligible account. Exported for the test; the handler below is
 * the queue binding.
 *
 * The cohort is the union of two sets, and the second one is the whole point:
 * accounts with enough recent rated days to be worth fitting, AND accounts
 * that already hold forecast rows. Without the second, an account that deleted
 * its entries would drop out of the cohort and keep its old forecast forever —
 * the sweep would never visit it again to clear it.
 */
export async function runMoodPrognosisRefresh(
  now: Date = new Date(),
  options: {
    isAvailable?: (userId: string) => Promise<boolean>;
    refresh?: typeof refreshAccount;
  } = {},
): Promise<MoodPrognosisRefreshSummary> {
  const isAvailable =
    options.isAvailable ??
    ((userId: string) => isModuleEnabled(userId, "mood"));
  const refresh = options.refresh ?? refreshAccount;
  const prisma = getWorkerPrisma();

  const since = dayKeyBefore(now, PROGNOSIS_FIT_WINDOW_DAYS);
  const [eligible, holders] = await Promise.all([
    prisma.moodEntry.groupBy({
      by: ["userId"],
      where: {
        deletedAt: null,
        moodA1: { not: null },
        date: { gte: since },
        ...OWNED_BY_ACTIVE_ACCOUNT,
      },
      _count: { _all: true },
    }),
    prisma.moodPrediction.findMany({
      where: OWNED_BY_ACTIVE_ACCOUNT,
      distinct: ["userId"],
      select: { userId: true },
    }),
  ]);

  const userIds = new Set<string>();
  for (const group of eligible) {
    // The cheap cut, so an account with a handful of entries never pays for a
    // window read. The real gate is the ladder inside the fit, which counts
    // DAYS rather than rows.
    if (group._count._all >= MIN_ENTRIES_FOR_FORECAST)
      userIds.add(group.userId);
  }
  for (const holder of holders) userIds.add(holder.userId);

  const summary: MoodPrognosisRefreshSummary = {
    scanned: userIds.size,
    refreshed: 0,
    rowsWritten: 0,
    refused: 0,
    moduleOff: 0,
    failed: 0,
  };

  for (const userId of userIds) {
    try {
      if (!(await isAvailable(userId))) {
        // An operator- or user-disabled module computes nothing and stores
        // nothing — and gives back anything it stored before.
        await prisma.moodPrediction.deleteMany({ where: { userId } });
        summary.moduleOff += 1;
        continue;
      }
      const outcome = await refresh(userId, now);
      if (outcome.refusal !== null) {
        summary.refused += 1;
        continue;
      }
      summary.refreshed += 1;
      summary.rowsWritten += outcome.rows;
    } catch {
      // One account's bad data must not cost every other account its forecast.
      // The count is what makes a systemic failure visible.
      summary.failed += 1;
    }
  }

  return summary;
}

export async function handleMoodPrognosisRefresh(
  jobs: Job<MoodPrognosisRefreshPayload>[],
): Promise<JobOutcome> {
  void jobs;
  return withBackgroundEvent("job.mood-prognosis-refresh", async (evt) => {
    const summary = await runMoodPrognosisRefresh();
    evt.addMeta("mood_prognosis_scanned", summary.scanned);
    evt.addMeta("mood_prognosis_refreshed", summary.refreshed);
    evt.addMeta("mood_prognosis_rows", summary.rowsWritten);
    evt.addMeta("mood_prognosis_refused", summary.refused);
    evt.addMeta("mood_prognosis_module_off", summary.moduleOff);
    evt.addMeta("mood_prognosis_failed", summary.failed);

    // Every account failing is a systemic fault (a dead pool, a schema drift),
    // not one account's bad data. Anything short of that stays a success with
    // the count on the event.
    if (summary.failed > 0 && summary.failed === summary.scanned) {
      return jobFailed(
        `mood-prognosis-refresh failed for all ${summary.failed} accounts`,
      );
    }
    return jobDone({
      users_scanned: summary.scanned,
      refreshed: summary.refreshed,
      rows_written: summary.rowsWritten,
      refused: summary.refused,
      module_off: summary.moduleOff,
      users_failed: summary.failed,
    });
  });
}
