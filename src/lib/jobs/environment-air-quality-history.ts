/**
 * v1.42 — the air-quality history backfill queue
 * (`src/lib/environment/air-quality-history.ts` does the work).
 *
 * Three ways in, all coalesced per account by `singletonKey`:
 *   - the boot discovery after an update and the nightly discovery tick
 *     (02:40 Europe/Berlin, after the 02:10 environment fetch), which offer
 *     every account with the module and its air quality on, a place to
 *     resolve days to, and a history that is not through or was last checked
 *     more than a week ago (old entries imported since);
 *   - setting the home location;
 *   - switching the air-quality part on.
 *
 * One run works through a bounded number of ranges and stores its progress.
 * When it made progress and the history is not through, and no budget
 * ceiling stopped it, it sends its own follow-up half a minute later. A run
 * the budget stopped sends none: the next nightly discovery resumes it, which
 * is what spreads a long history over several days. The module gate and the
 * air-quality switches are re-read on every run, so switching either off
 * ends the chain.
 *
 * The queue name MUST be registered in `allQueues` in
 * `src/lib/jobs/reminder/register-maintenance.ts`, or the sends silently
 * no-op.
 */
import type { PgBoss } from "pg-boss";

import { prisma } from "@/lib/db";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import { jobDone, jobFailed, type JobOutcome } from "@/lib/jobs/job-outcome";
import {
  getOperatorModuleAvailability,
  isModuleEnabled,
  normalisePrefs,
  resolveModuleEnabled,
} from "@/lib/modules/gate";
import { isAirQualityOperatorDisabled } from "@/lib/environment/open-meteo-air-quality";
import {
  readAirQualityHistoryState,
  runAirQualityHistory,
} from "@/lib/environment/air-quality-history";
import { workerLog } from "./reminder/shared";

export const ENVIRONMENT_AQ_HISTORY_QUEUE = "environment-aq-history";

/** Daily 02:40 Europe/Berlin, after the nightly environment fetch. */
export const ENVIRONMENT_AQ_HISTORY_CRON = "40 2 * * *";

/** Delay before a run's follow-up, in seconds. */
export const AQ_HISTORY_CONTINUATION_DELAY_SECONDS = 30;

/** Follow-ups one chain may send before it waits for the next discovery. */
export const AQ_HISTORY_MAX_CONTINUATIONS = 50;

/** A history checked longer ago than this is offered again (new old entries). */
const AQ_HISTORY_RECHECK_MS = 7 * 24 * 60 * 60 * 1000;

export interface EnvironmentAqHistoryPayload {
  /** Absent on the discovery tick. */
  userId?: string;
  continuation?: number;
}

function singletonKey(userId: string): string {
  return `environment-aq-history:${userId}`;
}

/**
 * Queue a history run for one account. No-ops cleanly without a worker (the
 * nightly discovery still covers it). A send while a run is queued collapses
 * into it.
 */
export async function enqueueAirQualityHistory(
  userId: string,
  startAfterSeconds: number = 0,
): Promise<boolean> {
  const boss = getGlobalBoss();
  if (!boss) return false;
  const id = await boss.send(
    ENVIRONMENT_AQ_HISTORY_QUEUE,
    { userId } satisfies EnvironmentAqHistoryPayload,
    {
      singletonKey: singletonKey(userId),
      ...(startAfterSeconds > 0 ? { startAfter: startAfterSeconds } : {}),
    },
  );
  return id != null;
}

/** Whether a stored progress means the account should be offered a run. */
export function historyDue(raw: unknown, now: Date = new Date()): boolean {
  const state = readAirQualityHistoryState(raw);
  if (!state || !state.complete) return true;
  const checked = Date.parse(state.checkedAt);
  return (
    !Number.isFinite(checked) || now.getTime() - checked > AQ_HISTORY_RECHECK_MS
  );
}

/**
 * Discovery: one run per account with the module on, its air quality on, a
 * home or a location period, and a history that is due. Nothing at all when
 * the operator turned air quality off.
 */
export async function discoverAirQualityHistory(
  boss: PgBoss,
  startAfterSeconds: number = 0,
): Promise<{ enqueued: number; skipped: number }> {
  if (isAirQualityOperatorDisabled()) return { enqueued: 0, skipped: 0 };
  const [candidates, operatorAvailability] = await Promise.all([
    prisma.user.findMany({
      where: {
        environmentAirQualityEnabled: true,
        OR: [
          { homeLocationEncrypted: { not: null } },
          { homeLat: { not: null }, homeLon: { not: null } },
          { environmentTravelLocations: { some: {} } },
        ],
      },
      select: {
        id: true,
        modulePreferencesJson: true,
        environmentAqHistoryJson: true,
      },
    }),
    getOperatorModuleAvailability(),
  ]);

  const now = new Date();
  let enqueued = 0;
  let skipped = 0;
  for (const candidate of candidates) {
    const moduleOn = resolveModuleEnabled(
      "environment",
      {
        gender: null,
        disableCoach: false,
        modulePreferences: normalisePrefs(candidate.modulePreferencesJson),
        cycleTrackingEnabled: null,
      },
      false,
      operatorAvailability,
    );
    if (!moduleOn || !historyDue(candidate.environmentAqHistoryJson, now)) {
      skipped += 1;
      continue;
    }
    await boss.send(
      ENVIRONMENT_AQ_HISTORY_QUEUE,
      { userId: candidate.id } satisfies EnvironmentAqHistoryPayload,
      {
        singletonKey: singletonKey(candidate.id),
        ...(startAfterSeconds > 0 ? { startAfter: startAfterSeconds } : {}),
      },
    );
    enqueued += 1;
  }
  return { enqueued, skipped };
}

/**
 * Boot discovery, staggered past the startup storm. Best-effort: the error
 * comes back in the result so worker boot never fails on it.
 */
export async function enqueueBootTimeAirQualityHistory(
  startAfterSeconds: number,
): Promise<{ enqueued: number; skipped: number; error: string | null }> {
  const boss = getGlobalBoss();
  if (!boss) return { enqueued: 0, skipped: 0, error: null };
  try {
    return {
      ...(await discoverAirQualityHistory(boss, startAfterSeconds)),
      error: null,
    };
  } catch (err) {
    return {
      enqueued: 0,
      skipped: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** The queue handler: discovery for an empty payload, else one account's run. */
export async function handleEnvironmentAqHistory(
  boss: PgBoss,
  payload: EnvironmentAqHistoryPayload,
): Promise<JobOutcome> {
  if (!payload.userId) {
    const { enqueued, skipped } = await discoverAirQualityHistory(boss);
    workerLog(
      "info",
      `[environment-aq-history] discovery enqueued=${enqueued} skipped=${skipped}`,
    );
    return jobDone({
      discovery_enqueued: enqueued,
      discovery_skipped: skipped,
    });
  }

  const userId = payload.userId;
  if (!(await isModuleEnabled(userId, "environment"))) {
    return jobDone({ skipped: "environment_module_disabled" });
  }

  const result = await runAirQualityHistory(userId);
  const continuation = payload.continuation ?? 0;
  let continued = false;
  if (
    result.status === "progress" &&
    result.filled > 0 &&
    continuation < AQ_HISTORY_MAX_CONTINUATIONS
  ) {
    await boss.send(
      ENVIRONMENT_AQ_HISTORY_QUEUE,
      {
        userId,
        continuation: continuation + 1,
      } satisfies EnvironmentAqHistoryPayload,
      {
        singletonKey: singletonKey(userId),
        startAfter: AQ_HISTORY_CONTINUATION_DELAY_SECONDS,
      },
    );
    continued = true;
  }
  workerLog(
    "info",
    `[environment-aq-history] user=${userId} status=${result.status} filled=${result.filled} done=${result.done}/${result.total} fetches=${result.fetches}${continued ? " continued" : ""}`,
  );
  // Every range failed at the feed: say so, so the failing-jobs card sees a
  // feed that keeps refusing. A budget stop is not a failure: nothing was
  // sent past the ceiling, and the next discovery resumes where it stopped.
  if (result.status === "error") {
    return jobFailed("air-quality history: every range failed", undefined, {
      fetches: result.fetches,
    });
  }
  return jobDone({
    outcome: result.status,
    days_stored: result.filled,
    fetches: result.fetches,
    budget_blocked: result.status === "budget",
    continued,
  });
}
