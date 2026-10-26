/**
 * v1.44 — the Oura history backfill: every collection's history, read once,
 * in resumable slices through the shared integration backfill lane.
 *
 * The hourly sync reads a window of days (hours for heart rate); everything
 * older is this job's. Discovery finds every Oura connection whose
 * `ouraBackfillCompletedAt` is unset (an existing connection included: the
 * column arrives empty, so no reconnect is needed), and the slices walk each
 * collection from the day the backfill began back to the start of the
 * account's history, window by window, noting after every window where they
 * got to (`../oura/backfill-progress.ts`). A slice ends on its own budget, on
 * the job's, when another heavy job wants the lane, or on Oura's rate limit,
 * and the next slice picks up at the window it stopped before. A collection
 * is never read again from the anchor once it has moved.
 *
 * Memory: a window of a day-keyed collection is at most ninety days of
 * records; heart rate is streamed a page at a time (`syncOuraHeartRateRange`)
 * and keeps only the days it touched. Nothing accumulates across windows.
 *
 * The first thing a backfill does, once per account, is retire the
 * equivalent-distance rows earlier syncs wrote (`retireOuraEquivalentDistance`).
 * An account that holds such rows but no longer has an Oura connection is
 * offered too: it retires them and is stamped complete, and a later connect
 * reopens the backfill (the callback clears the stamp).
 *
 * The marker is stamped only when every collection is done or refused for a
 * scope the grant lacks; the progress note stays beside it, so a reconnect
 * that grants the missing scope reads only those collections: the first slice
 * of every chain asks again for the refused ones.
 */
import { ACTIVE_ACCOUNT } from "@/lib/account-deletion/active-account";
import { prisma } from "@/lib/db";
import { annotate, getEvent } from "@/lib/logging/context";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import {
  enqueueIntegrationBackfillAdmission,
  INTEGRATION_BACKFILL_CONTINUATION_DELAY_SECONDS,
  integrationBackfillSourceOptions,
} from "@/lib/jobs/integration-backfill-admission";
import { LANE_YIELD_DELAY_SECONDS, laneWanted } from "@/lib/jobs/heavy-lane";
import { reportJobProgress } from "@/lib/jobs/job-observer";
import { isReauthRequired } from "@/lib/integrations/status";
import { shiftDateKey, userDayKey } from "@/lib/tz/format";
import { resolveUserTimezone } from "@/lib/tz/resolver";
import { startOfLocalDayKey } from "@/lib/tz/local-day";
import { sweepStaleSleepSegments } from "@/lib/sleep/sweep-stale-segments";
import { getOuraConnection } from "@/lib/oura/credentials";
import { refreshOuraAfterRefusal } from "@/lib/oura/oauth-descriptor";
import { OuraApiError } from "@/lib/oura/response-classifier";
import { OURA_COLLECTIONS, type OuraCollectionName } from "@/lib/oura/scope";
import {
  isNamedScopeRefusal,
  isTokenRefusal,
  ouraCollectionReader,
  ouraRunContext,
  recordOuraSyncFailure,
  retireOuraSleepRecords,
  upsertOuraMeasurements,
} from "@/lib/oura/sync";
import { refoldOuraTouchedDays } from "@/lib/oura/sync-heart-rate";
import {
  OURA_EQUIVALENT_DISTANCE_WHERE,
  retireOuraEquivalentDistance,
} from "@/lib/oura/retire-distance";
import {
  OURA_HISTORY_FLOOR,
  ouraBackfillProgressJson,
  readOuraBackfillProgress,
  withoutDenied,
  type OuraBackfillProgress,
} from "@/lib/oura/backfill-progress";
import { OURA_BACKFILL_QUEUE } from "./oura-backfill-queue";

/**
 * One slice: five minutes of walking, then the account is let go and the
 * rest is the next slice's. Short so a slice never sits long on the lane.
 */
export const OURA_BACKFILL_SLICE_MS = 5 * 60 * 1000;

/** The pause before the next slice after a rate limit that named no wait. */
export const OURA_BACKFILL_THROTTLED_DELAY_SECONDS = 5 * 60;

/**
 * The highest slice a chain may reach. Eleven years of history is about 600
 * heart-rate windows and a few hundred more for the rest, and a slice writes
 * dozens of windows; two thousand slices bounds nothing a working backfill
 * reaches, and stops one that counts progress it does not make.
 */
export const OURA_BACKFILL_MAX_SLICE = 2000;

/** Days per window, by collection: dense or heavy ones read shorter windows. */
const WINDOW_DAYS: Partial<Record<OuraCollectionName, number>> = {
  sleep: 30,
  heartrate: 7,
};
const DEFAULT_WINDOW_DAYS = 90;

/** The collections that find where history starts; walked first. */
const HISTORY_PROBES: readonly OuraCollectionName[] = ["activity", "sleep"];

/** How far before the learned history start the other collections reach. */
const HISTORY_MARGIN_DAYS = 7;

/** Walk order: the history probes first, heart rate (the dense one) last. */
export const OURA_BACKFILL_ORDER: readonly OuraCollectionName[] = [
  ...HISTORY_PROBES,
  ...OURA_COLLECTIONS.map((c) => c.name).filter(
    (n) => !HISTORY_PROBES.includes(n) && n !== "heartrate",
  ),
  "heartrate",
];

export interface OuraBackfillPayload {
  userId: string;
  enqueuedAt: string;
}

/** Test seam: a slice's budget and clock. */
export interface OuraBackfillSliceOptions {
  sliceMs?: number;
  now?: () => number;
}

type StopReason = "budget" | "lane_wanted" | "rate_limited";

function minDay(a: string | undefined, b: string): string {
  return a === undefined || b < a ? b : a;
}

/** The floor a collection walks back to, or undefined while not yet known. */
function floorFor(
  name: OuraCollectionName,
  progress: OuraBackfillProgress,
): string | undefined {
  if (HISTORY_PROBES.includes(name)) return OURA_HISTORY_FLOOR;
  if (progress.historyStart === undefined) return undefined;
  // No activity and no sleep anywhere: there is no history to read.
  if (progress.historyStart === null) return progress.anchor;
  const margin = shiftDateKey(progress.historyStart, -HISTORY_MARGIN_DAYS);
  return margin < OURA_HISTORY_FLOOR ? OURA_HISTORY_FLOOR : margin;
}

/** Settle `historyStart` once both probes are finished. */
function settleHistoryStart(progress: OuraBackfillProgress): void {
  if (progress.historyStart !== undefined) return;
  const finished = HISTORY_PROBES.every((n) => {
    const s = progress.collections[n];
    return s?.done || s?.denied;
  });
  if (finished) progress.historyStart = progress.oldestSeen ?? null;
}

async function saveProgress(
  userId: string,
  progress: OuraBackfillProgress,
): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { ouraBackfillProgress: ouraBackfillProgressJson(progress) },
  });
}

/**
 * Read and write one window of one collection. Returns the oldest day a
 * history probe returned, if any.
 */
async function runWindow(
  userId: string,
  tz: string,
  name: OuraCollectionName,
  window: { startDate: string; endDate: string },
  token: string,
): Promise<{ oldestDay?: string; imported: number }> {
  const ctx = ouraRunContext(
    userId,
    tz,
    window,
    // The heart-rate window covers the same local days, end day included.
    {
      start: startOfLocalDayKey(window.startDate, tz),
      end: startOfLocalDayKey(shiftDateKey(window.endDate, 1), tz),
    },
    false,
  );
  const readings = await ouraCollectionReader(name, ctx)(token);
  await sweepStaleSleepSegments(userId, "OURA", ctx.sleepSweeps);
  await retireOuraSleepRecords(userId, ctx.sleepRetirements);
  const written = await upsertOuraMeasurements(userId, readings, {
    emitArrivals: false,
  });
  await refoldOuraTouchedDays(userId, ctx.heartRateTouched);
  let oldestDay: string | undefined;
  if (HISTORY_PROBES.includes(name)) {
    for (const r of readings) {
      oldestDay = minDay(oldestDay, userDayKey(r.measuredAt, tz));
    }
    // A probe that only retired periods still saw history.
    if (ctx.sleepRetirements.length > 0 || ctx.sleepSweeps.length > 0) {
      oldestDay = minDay(oldestDay, window.startDate);
    }
  }
  return { oldestDay, imported: written + ctx.sideImported };
}

/**
 * Run one slice of the backfill for one account. Returns how many rows it
 * wrote and whether it sent the next slice.
 */
export async function runOuraBackfillForUser(
  userId: string,
  shouldStop: () => boolean = () => false,
  slice: number = 0,
  options: OuraBackfillSliceOptions = {},
): Promise<{ imported: number; continued: boolean }> {
  if (slice > OURA_BACKFILL_MAX_SLICE) {
    throw new Error(
      `oura backfill for user ${userId} reached slice ${slice}, past the ceiling of ${OURA_BACKFILL_MAX_SLICE}`,
    );
  }
  const now = options.now ?? Date.now;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { ouraBackfillProgress: true, ouraBackfillCompletedAt: true },
  });
  if (!user || user.ouraBackfillCompletedAt) {
    annotate({
      action: { name: "oura.backfill.already_complete", details: { slice } },
    });
    return { imported: 0, continued: false };
  }

  const tz = await resolveUserTimezone(userId);
  const stored = readOuraBackfillProgress(
    user.ouraBackfillProgress,
    OURA_BACKFILL_ORDER,
  );
  // The first slice of a chain (a boot's, or a connect's) asks again for
  // what an earlier grant refused: the grant may cover it now. One request
  // each finds out; everything already walked stays walked.
  const progress: OuraBackfillProgress = stored
    ? slice === 0
      ? withoutDenied(stored)
      : stored
    : { anchor: userDayKey(new Date(now()), tz), collections: {} };

  if (!progress.distanceRetired) {
    const retired = await retireOuraEquivalentDistance(userId);
    progress.distanceRetired = true;
    await saveProgress(userId, progress);
    annotate({ meta: { "oura.backfill.distance_retired": retired } });
  }

  const conn = await getOuraConnection(userId);
  if (!conn) {
    // Nothing to read: the account only had legacy rows to retire. A later
    // connect reopens the backfill.
    await prisma.user.update({
      where: { id: userId },
      data: { ouraBackfillCompletedAt: new Date(now()) },
    });
    return { imported: 0, continued: false };
  }
  if (await isReauthRequired(userId, "oura")) {
    annotate({
      action: { name: "oura.backfill.skipped_reauth", details: { slice } },
    });
    return { imported: 0, continued: false };
  }

  const deadline = now() + (options.sliceMs ?? OURA_BACKFILL_SLICE_MS);
  const knownDenied = new Set(conn.scopeDenied ?? []);
  let token = conn.accessToken;
  let refreshed = false;
  let imported = 0;
  let windowsWritten = 0;
  let newlySettled = 0;
  let stopReason: StopReason | null = null;
  let retryAfterMs: number | undefined;
  let failure: unknown;
  const failures: OuraCollectionName[] = [];

  walk: for (const name of OURA_BACKFILL_ORDER) {
    const state = progress.collections[name] ?? { before: progress.anchor };
    progress.collections[name] = state;
    if (state.done || state.denied) continue;
    const floor = floorFor(name, progress);
    // The other collections wait for the probes to say where history starts;
    // the probes come first, so this is only a slice that ended in them.
    if (floor === undefined) break;

    while (!state.done && !state.denied) {
      if (state.before <= floor) {
        state.done = true;
        newlySettled += 1;
        settleHistoryStart(progress);
        await saveProgress(userId, progress);
        break;
      }
      if (shouldStop() || now() >= deadline) {
        stopReason = "budget";
        break walk;
      }
      if (laneWanted()) {
        stopReason = "lane_wanted";
        break walk;
      }
      const windowDays = WINDOW_DAYS[name] ?? DEFAULT_WINDOW_DAYS;
      const shifted = shiftDateKey(state.before, -windowDays);
      const startDate = shifted < floor ? floor : shifted;
      const window = { startDate, endDate: state.before };

      let result: { oldestDay?: string; imported: number };
      try {
        try {
          result = await runWindow(userId, tz, name, window, token);
        } catch (err) {
          if (!isTokenRefusal(err) || refreshed) throw err;
          // A refused token: refresh once for the whole slice, then retry.
          refreshed = true;
          let next: string | null;
          try {
            next = await refreshOuraAfterRefusal(
              userId,
              conn.refreshTokenCiphertext,
            );
          } catch (refreshErr) {
            await recordOuraSyncFailure(userId, refreshErr);
            throw refreshErr;
          }
          if (!next) throw err;
          token = next;
          result = await runWindow(userId, tz, name, window, token);
        }
      } catch (err) {
        if (
          isNamedScopeRefusal(err) ||
          (isTokenRefusal(err) && knownDenied.has(name))
        ) {
          // The grant does not cover this collection: a scope note, not a
          // failure. The others go on; a reconnect reopens it.
          state.denied = true;
          newlySettled += 1;
          settleHistoryStart(progress);
          await saveProgress(userId, progress);
          annotate({ meta: { "oura.backfill.denied": name } });
          break;
        }
        if (err instanceof OuraApiError && err.httpStatus === 429) {
          stopReason = "rate_limited";
          retryAfterMs = err.retryAfterMs;
          break walk;
        }
        // One collection's failure stays with it: the slice goes on with the
        // next one, and the failed window is read again next slice.
        failures.push(name);
        failure ??= err;
        getEvent()?.addWarning(
          `oura backfill: ${name} ${window.startDate}..${window.endDate} failed: ${err}`,
        );
        continue walk;
      }

      imported += result.imported;
      windowsWritten += 1;
      if (result.oldestDay) {
        progress.oldestSeen = minDay(progress.oldestSeen, result.oldestDay);
      }
      state.before = startDate;
      state.windows = (state.windows ?? 0) + 1;
      await saveProgress(userId, progress);
    }
  }

  const settled = OURA_BACKFILL_ORDER.every((n) => {
    const s = progress.collections[n];
    return s?.done || s?.denied;
  });
  const report = {
    slice,
    stopReason,
    failures,
    windowsWritten,
    imported,
    edges: Object.fromEntries(
      Object.entries(progress.collections).map(([n, s]) => [
        n,
        s!.done ? "done" : s!.denied ? "denied" : s!.before,
      ]),
    ),
    historyStart: progress.historyStart ?? null,
  };
  annotate({ meta: { "oura.backfill.slice": report } });
  reportJobProgress({
    oura_backfill_slice: slice,
    oura_backfill_windows: windowsWritten,
  });

  if (settled && stopReason === null && failures.length === 0) {
    await prisma.user.update({
      where: { id: userId },
      data: {
        ouraBackfillCompletedAt: new Date(now()),
        ouraBackfillProgress: ouraBackfillProgressJson(progress),
      },
    });
    annotate({
      action: { name: "oura.backfill.complete", details: { imported, slice } },
    });
    return { imported, continued: false };
  }

  const progressed = windowsWritten > 0 || newlySettled > 0;
  // A rate limit passes on its own: the next slice goes after it, progress
  // or not, as Strava's backfill does. Anything else needs progress to go on.
  if (progressed || stopReason === "rate_limited") {
    const delaySeconds =
      stopReason === "rate_limited"
        ? Math.max(
            INTEGRATION_BACKFILL_CONTINUATION_DELAY_SECONDS,
            retryAfterMs !== undefined
              ? Math.ceil(retryAfterMs / 1000)
              : OURA_BACKFILL_THROTTLED_DELAY_SECONDS,
          )
        : stopReason === "lane_wanted"
          ? LANE_YIELD_DELAY_SECONDS
          : INTEGRATION_BACKFILL_CONTINUATION_DELAY_SECONDS;
    if (await sendNextSlice(userId, slice, delaySeconds)) {
      annotate({
        action: {
          name: "oura.backfill.continued",
          details: { slice, stopReason, windowsWritten, delaySeconds },
        },
      });
      return { imported, continued: true };
    }
  }

  // Nothing moved, or no next slice could be sent: the pg-boss retry and,
  // after it, the next boot's discovery take it from here. The progress
  // note stands, so whatever runs next starts where this one stopped.
  throw new Error(
    `oura backfill incomplete for user ${userId} (slice ${slice}${stopReason ? `, stopped on ${stopReason}` : ""}${failure ? `: ${failure instanceof Error ? failure.message : String(failure)}` : ""})`,
  );
}

async function sendNextSlice(
  userId: string,
  slice: number,
  delaySeconds: number,
): Promise<boolean> {
  if (slice + 1 > OURA_BACKFILL_MAX_SLICE) return false;
  const boss = getGlobalBoss();
  if (!boss) return false;
  const sent = await enqueueIntegrationBackfillAdmission(
    boss,
    {
      kind: "oura-backfill",
      data: { userId, enqueuedAt: new Date().toISOString(), slice: slice + 1 },
    },
    delaySeconds,
  );
  return Boolean(sent);
}

/**
 * Boot-time discovery: every account with an Oura connection whose backfill
 * is not stamped, and every account still holding equivalent-distance rows
 * from before the fix. Idempotent across reboots; errors come back in the
 * result so the worker boot never fails on a miss.
 */
export async function enqueueBootTimeOuraBackfill(
  startAfterSeconds: number = 0,
): Promise<{ enqueued: number; skipped: number; error: string | null }> {
  const boss = getGlobalBoss();
  if (!boss) return { enqueued: 0, skipped: 0, error: null };
  try {
    const users = await prisma.user.findMany({
      where: {
        ouraBackfillCompletedAt: null,
        ...ACTIVE_ACCOUNT,
        OR: [
          { ouraAccessTokenEncrypted: { not: null } },
          { measurements: { some: OURA_EQUIVALENT_DISTANCE_WHERE } },
        ],
      },
      select: { id: true },
    });
    let enqueued = 0;
    let skipped = 0;
    for (const { id: userId } of users) {
      const payload: OuraBackfillPayload = {
        userId,
        enqueuedAt: new Date().toISOString(),
      };
      const jobId = await boss.send(
        OURA_BACKFILL_QUEUE,
        payload,
        integrationBackfillSourceOptions(
          `oura-backfill|${userId}`,
          startAfterSeconds,
        ),
      );
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
