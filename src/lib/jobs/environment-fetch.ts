/**
 * v1.25 (W-ENV) — nightly environmental-context fetch.
 *
 * For every account with the environmental-context module enabled AND a home
 * location set, fetch the daily weather/daylight for the recent uncovered days
 * and upsert into `EnvironmentContext`. A daily discovery tick (empty payload)
 * fans out one per-user job; the per-user job resolves each day's location
 * conservatively (explicit location period → home only on/after its effective
 * date → else SKIP — never the current home for a pre-home past day) and fetches
 * a lookback window so the archive feed's settling lag (a few days) is absorbed
 * and any day missed across worker reboots is re-attempted. The same handler
 * also serves the on-demand backfill (an explicit `{ userId, startDate, endDate }`
 * payload from the settings surface).
 *
 * Opt-in + privacy: the discovery filter requires both the module flag and a
 * home location, so a disabled account never triggers an outbound fetch. Egress
 * runs through `safeFetch` inside the Open-Meteo client. Recurring → pg-boss
 * (never a CLI script; the prod image strips `tsx`).
 *
 * v1.42 (#615) — the same per-user run fetches air quality, pollen and UV
 * with the weather, and then fills up to 90 stored days whose air-quality
 * part is still missing, newest first (`fillAirQualityGaps`). Every request
 * asks the instance-wide Open-Meteo budget first; a refused request ends the
 * run as done with `budget_blocked`, and the next night continues. The home
 * is found by its sealed copy as well as by the readable columns the
 * encryption backfill has not cleared yet.
 */
import { prisma } from "@/lib/db";
import type { PgBoss } from "pg-boss";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import {
  getOperatorModuleAvailability,
  isModuleEnabled,
  normalisePrefs,
  resolveModuleEnabled,
} from "@/lib/modules/gate";
import {
  ENVIRONMENT_LOOKBACK_DAYS,
  ENVIRONMENT_MAX_BACKFILL_DAYS,
  fetchAndStoreEnvironment,
  fillAirQualityGaps,
  utcDayKey,
} from "@/lib/environment/service";
import { enumerateDayCount } from "@/lib/environment/day-span";
import { recordError } from "@/lib/jobs/worker-status";
import { jobDone, jobFailed, type JobOutcome } from "@/lib/jobs/job-outcome";
import { workerLog } from "./reminder/shared";

export const ENVIRONMENT_FETCH_QUEUE = "environment-fetch";

/** Daily 02:10 Europe/Berlin — early, before the 02:30+ maintenance window so
 * the night's weather rows exist before any briefing/insight pre-gen reads. */
export const ENVIRONMENT_FETCH_CRON = "10 2 * * *";

export const ENVIRONMENT_FETCH_CONCURRENCY = 1;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Per-user fetch payload. An empty payload (no `userId`) is the daily discovery
 * tick. `startDate`/`endDate` (YYYY-MM-DD) drive the on-demand backfill; omitted
 * ⇒ the default lookback window ending today.
 */
export interface EnvironmentFetchPayload {
  userId?: string;
  startDate?: string;
  endDate?: string;
}

/** Resolve the date range for a per-user run (explicit range, else lookback). */
function resolveRange(payload: EnvironmentFetchPayload): {
  startDate: string;
  endDate: string;
} {
  const today = new Date();
  const endDate = payload.endDate ?? utcDayKey(today);
  const startDate =
    payload.startDate ??
    utcDayKey(
      new Date(today.getTime() - ENVIRONMENT_LOOKBACK_DAYS * MS_PER_DAY),
    );
  return { startDate, endDate };
}

/**
 * Request-side enqueue for a single account: a default-lookback refresh (after
 * the user sets/changes their home, so weather appears without waiting for the
 * nightly tick) or an explicit-range backfill. No-ops cleanly when no global
 * boss is bound (e.g. a web-only deployment) — the nightly cron still covers it.
 * The lookback variant is singleton-coalesced per user; an explicit backfill
 * range is NOT coalesced so it always runs.
 */
export async function enqueueEnvironmentFetch(
  payload: EnvironmentFetchPayload & { userId: string },
): Promise<boolean> {
  const boss = getGlobalBoss();
  if (!boss) return false;
  const options =
    payload.startDate || payload.endDate
      ? undefined
      : { singletonKey: `environment-fetch:${payload.userId}` };
  await boss.send(ENVIRONMENT_FETCH_QUEUE, payload, options);
  return true;
}

/** One account's backfill slot: at most one backfill job per slot. */
export const ENVIRONMENT_BACKFILL_SINGLETON_SECONDS = 20 * 60;

/**
 * Enqueue the on-demand backfill a person asked for from the settings
 * surface. Unlike the travel-period refresh, it carries a per-account
 * `singletonKey` with a time slot, so one account has at most one backfill
 * per twenty minutes no matter how often the button is pressed; pg-boss
 * enforces the slot (`singleton_on`) under every queue policy. A send the
 * slot refuses comes back as `already_queued`, and the route says so instead
 * of reporting a job that will not run.
 */
export async function enqueueEnvironmentBackfill(payload: {
  userId: string;
  startDate: string;
  endDate: string;
}): Promise<"enqueued" | "no_worker" | "already_queued"> {
  const boss = getGlobalBoss();
  if (!boss) return "no_worker";
  const id = await boss.send(ENVIRONMENT_FETCH_QUEUE, payload, {
    singletonKey: `environment-backfill:${payload.userId}`,
    singletonSeconds: ENVIRONMENT_BACKFILL_SINGLETON_SECONDS,
  });
  return id ? "enqueued" : "already_queued";
}

/**
 * Discovery fan-out: enqueue one per-user fetch job for every account with the
 * module on and a home location set. Idempotent (singletonKey-coalesced per
 * user). Returns counts for the worker log.
 */
export async function enqueueEnvironmentFetchDiscovery(
  boss: PgBoss,
): Promise<{ enqueued: number; skipped: number }> {
  // Candidate set: a home location is required for any non-override day, so an
  // account without one cannot produce a row. The opt-in flag + operator
  // availability are then resolved in-memory from the candidates' preference
  // blobs — one operator-availability read + one `findMany`, instead of an
  // `isModuleEnabled` round-trip per candidate (N serial reads on a large
  // instance). `environment` is opt-in and non-delegated, so the resolver only
  // consults the per-user preference map + the operator availability.
  const [candidates, operatorAvailability] = await Promise.all([
    prisma.user.findMany({
      // The sealed home (v1.42), or the readable one a row the encryption
      // backfill has not reached yet still carries.
      where: {
        OR: [
          { homeLocationEncrypted: { not: null } },
          { homeLat: { not: null }, homeLon: { not: null } },
        ],
      },
      select: { id: true, modulePreferencesJson: true },
    }),
    getOperatorModuleAvailability(),
  ]);

  let enqueued = 0;
  let skipped = 0;
  for (const { id, modulePreferencesJson } of candidates) {
    const isEnabled = resolveModuleEnabled(
      "environment",
      {
        gender: null,
        disableCoach: false,
        modulePreferences: normalisePrefs(modulePreferencesJson),
        cycleTrackingEnabled: null,
      },
      false,
      operatorAvailability,
    );
    if (!isEnabled) {
      skipped += 1;
      continue;
    }
    await boss.send(
      ENVIRONMENT_FETCH_QUEUE,
      { userId: id } satisfies EnvironmentFetchPayload,
      { singletonKey: `environment-fetch:${id}` },
    );
    enqueued += 1;
  }
  return { enqueued, skipped };
}

/**
 * The queue handler. Empty payload ⇒ discovery fan-out; a `userId` payload ⇒
 * fetch + upsert for that user across the resolved range. Re-checks the module
 * gate on the per-user path so a backfill enqueued just before the user
 * disabled the module is a no-op.
 */
export async function handleEnvironmentFetch(
  boss: PgBoss,
  payload: EnvironmentFetchPayload,
): Promise<JobOutcome> {
  if (!payload.userId) {
    const { enqueued, skipped } = await enqueueEnvironmentFetchDiscovery(boss);
    workerLog(
      "info",
      `[environment-fetch] discovery enqueued=${enqueued} skipped=${skipped}`,
    );
    return jobDone({ users_enqueued: enqueued, users_skipped: skipped });
  }

  const userId = payload.userId;
  if (!(await isModuleEnabled(userId, "environment"))) {
    workerLog(
      "info",
      `[environment-fetch] user=${userId} module disabled — skipping`,
    );
    return jobDone({ skipped: "environment_module_disabled" });
  }

  const { startDate, endDate } = resolveRange(payload);
  // Clamp the span so a crafted backfill can never fan out an unbounded range.
  const span = enumerateDayCount(startDate, endDate);
  if (span > ENVIRONMENT_MAX_BACKFILL_DAYS) {
    workerLog(
      "error",
      `[environment-fetch] user=${userId} range ${startDate}..${endDate} (${span}d) exceeds cap — skipping`,
    );
    // A refused range is not an opt-out: the job was asked to fill days and
    // filled none, so it says so instead of completing quietly on a stderr line.
    return jobFailed("environment backfill range exceeds cap", undefined, {
      span_days: span,
    });
  }

  try {
    const result = await fetchAndStoreEnvironment({
      userId,
      startDate,
      endDate,
    });
    // The gap fill runs on the nightly path only; an explicit backfill range
    // already fetched the air quality of the days it stored. It is skipped
    // when the budget already refused this run.
    const explicitRange = payload.startDate != null || payload.endDate != null;
    const gaps =
      explicitRange || result.budgetBlocked
        ? { filled: 0, stopped: null }
        : await fillAirQualityGaps(userId);
    const budgetBlocked = result.budgetBlocked || gaps.stopped === "budget";
    workerLog(
      "info",
      `[environment-fetch] user=${userId} ${startDate}..${endDate} stored=${result.stored} skipped=${result.skipped} fetches=${result.fetches} aq_gap_days=${gaps.filled}${budgetBlocked ? " budget_blocked" : ""}`,
    );
    // A refused request is not a failure: nothing was sent, and the days it
    // would have filled are exactly what the next night looks for.
    return jobDone({
      days_stored: result.stored,
      days_skipped: result.skipped,
      fetches: result.fetches,
      rows_upserted: gaps.filled,
      budget_blocked: budgetBlocked,
    });
  } catch (err) {
    recordError();
    workerLog("error", `[environment-fetch] user=${userId} failed`, err);
    throw err;
  }
}
