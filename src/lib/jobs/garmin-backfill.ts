/**
 * The Garmin history backfill: every resource's history, read once,
 * in resumable slices through the shared integration backfill lane.
 *
 * The hourly sync reads a window of recent days; everything older is this
 * job's. A connect clears `garminBackfillCompletedAt` and sends the first
 * slice; boot discovery re-offers every connection whose stamp is unset. A
 * slice walks the resources in `GARMIN_BACKFILL_STEPS` order, window by
 * window, noting after every window where it got to
 * (`../garmin/backfill-progress.ts`). It ends on its own budget, on the
 * job's, when another heavy job wants the lane, or on Garmin's rate limit
 * (waiting at least as long as `Retry-After` asks), and the next slice picks
 * up at the window it stopped before.
 *
 * A refused key ends the chain: the connection is parked at
 * `reauth_required` and a reconnect starts a new chain where this one
 * stopped.
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
import { isCycleAvailableForUser } from "@/lib/cycle/gate";
import { shiftDateKey, userDayKey } from "@/lib/tz/format";
import { resolveUserTimezone } from "@/lib/tz/resolver";
import {
  GarminSession,
  isGarminKeyRefusal,
  isGarminRateLimit,
  type GarminTransport,
} from "@/lib/garmin/client";
import {
  getGarminCredentials,
  rememberGarminKeyExpiry,
} from "@/lib/garmin/credentials";
import {
  periodFromGarminCycleSummary,
  readGarminCycleSummary,
  writeGarminPeriodDays,
} from "@/lib/garmin/cycle-sync";
import {
  GARMIN_RESOURCE_WINDOW_DAYS,
  readGarminWindow,
  recordGarminSyncFailure,
  upsertGarminMeasurements,
} from "@/lib/garmin/sync";
import { upsertGarminWorkouts } from "@/lib/garmin/sync-workouts";
import {
  GARMIN_BACKFILL_STEPS,
  GARMIN_HISTORY_FLOOR,
  garminBackfillProgressJson,
  readGarminBackfillProgress,
  type GarminBackfillProgress,
  type GarminBackfillStep,
  type GarminBackfillStepState,
} from "@/lib/garmin/backfill-progress";
import { GARMIN_BACKFILL_QUEUE } from "./garmin-backfill-queue";

/** One slice: five minutes of walking, then the rest is the next slice's. */
export const GARMIN_BACKFILL_SLICE_MS = 5 * 60 * 1000;

/** The pause after a rate limit that named no wait. */
export const GARMIN_BACKFILL_THROTTLED_DELAY_SECONDS = 15 * 60;

/**
 * The highest slice a chain may reach. Eighteen years of history is a few
 * hundred windows in all; a slice writes dozens. A chain past this count
 * counts progress it does not make.
 */
export const GARMIN_BACKFILL_MAX_SLICE = 500;

/** The resources that find where history starts; walked first. */
const HISTORY_PROBES: readonly GarminBackfillStep[] = ["daily", "activities"];

/** How far before the learned history start the other resources reach. */
const HISTORY_MARGIN_DAYS = 7;

/** Window size of the history walk per resource (the probes read wide). */
const BACKFILL_WINDOW_DAYS: Record<
  Exclude<GarminBackfillStep, "cycle">,
  number
> = {
  daily: GARMIN_RESOURCE_WINDOW_DAYS.daily,
  activities: 365,
  sleep: 93,
  hrv: 93,
  weight: 186,
};

/** Cycles read per slice at most (one request each). */
const MAX_CYCLES_PER_SLICE = 60;

export interface GarminBackfillPayload {
  userId: string;
  enqueuedAt: string;
}

export interface GarminBackfillSliceOptions {
  sliceMs?: number;
  now?: () => number;
  transport?: GarminTransport;
}

type StopReason = "budget" | "lane_wanted" | "rate_limited";

function minDay(
  a: string | undefined,
  b: string | undefined,
): string | undefined {
  if (b === undefined) return a;
  return a === undefined || b < a ? b : a;
}

function floorFor(
  step: GarminBackfillStep,
  progress: GarminBackfillProgress,
): string | undefined {
  if (HISTORY_PROBES.includes(step)) return GARMIN_HISTORY_FLOOR;
  if (progress.historyStart === undefined) return undefined;
  if (progress.historyStart === null) return progress.anchor;
  const margin = shiftDateKey(progress.historyStart, -HISTORY_MARGIN_DAYS);
  return margin < GARMIN_HISTORY_FLOOR ? GARMIN_HISTORY_FLOOR : margin;
}

function settleHistoryStart(progress: GarminBackfillProgress): void {
  if (progress.historyStart !== undefined) return;
  if (HISTORY_PROBES.every((s) => progress.steps[s]?.done)) {
    progress.historyStart = progress.oldestSeen ?? null;
  }
}

async function saveProgress(
  userId: string,
  progress: GarminBackfillProgress,
): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { garminBackfillProgress: garminBackfillProgressJson(progress) },
  });
}

interface SliceContext {
  userId: string;
  tz: string;
  progress: GarminBackfillProgress;
  session: GarminSession;
  cycleAvailable: boolean;
  shouldStop: () => boolean;
  now: () => number;
  deadline: number;
}

interface SliceWalk {
  imported: number;
  windowsWritten: number;
  newlySettled: number;
  stopReason: StopReason | null;
  retryAfterMs: number | undefined;
  failure: unknown;
  failures: GarminBackfillStep[];
}

/**
 * Read one window of a step and write it. Returns rows written, or null when
 * the step reached its end (the cycle walk found no older cycle).
 */
async function readStepWindow(
  ctx: SliceContext,
  step: GarminBackfillStep,
  state: GarminBackfillStepState,
  floor: string,
): Promise<number | null> {
  const { userId, progress, session } = ctx;
  if (step === "cycle") {
    const summary = await readGarminCycleSummary(session, state.before);
    const period = periodFromGarminCycleSummary(summary, progress.anchor);
    // No logged cycle at or before this day: the walk is over.
    if (!period || period.start > state.before) return null;
    await writeGarminPeriodDays(userId, period.days);
    state.before = shiftDateKey(period.start, -1);
    return 0;
  }
  const shifted = shiftDateKey(state.before, -(BACKFILL_WINDOW_DAYS[step] - 1));
  const startDate = shifted < floor ? floor : shifted;
  const read = await readGarminWindow(
    session,
    step,
    { startDate, endDate: state.before },
    ctx.tz,
  );
  let written = await upsertGarminMeasurements(userId, read.measurements, {
    emitArrivals: false,
  });
  written += await upsertGarminWorkouts(userId, read.workouts, {
    emitArrivals: false,
  });
  if (HISTORY_PROBES.includes(step)) {
    progress.oldestSeen = minDay(progress.oldestSeen, read.oldestDay);
  }
  state.before = shiftDateKey(startDate, -1);
  return written;
}

/** Walk the steps until the slice's budget, the lane, a limit or the end. */
async function walkSlice(ctx: SliceContext): Promise<SliceWalk> {
  const { userId, progress } = ctx;
  const out: SliceWalk = {
    imported: 0,
    windowsWritten: 0,
    newlySettled: 0,
    stopReason: null,
    retryAfterMs: undefined,
    failure: undefined,
    failures: [],
  };
  const settle = async (state: { done?: boolean }) => {
    state.done = true;
    out.newlySettled += 1;
    settleHistoryStart(progress);
    await saveProgress(userId, progress);
  };

  walk: for (const step of GARMIN_BACKFILL_STEPS) {
    const state = progress.steps[step] ?? { before: progress.anchor };
    progress.steps[step] = state;
    if (state.done) continue;
    const floor = floorFor(step, progress);
    if (floor === undefined) break;
    if (step === "cycle" && !ctx.cycleAvailable) {
      await settle(state);
      continue;
    }
    let windows = 0;
    while (!state.done) {
      if (state.before <= floor) {
        await settle(state);
        break;
      }
      if (
        ctx.shouldStop() ||
        ctx.now() >= ctx.deadline ||
        (step === "cycle" && windows >= MAX_CYCLES_PER_SLICE)
      ) {
        out.stopReason = "budget";
        break walk;
      }
      if (laneWanted()) {
        out.stopReason = "lane_wanted";
        break walk;
      }
      try {
        windows += 1;
        const written = await readStepWindow(ctx, step, state, floor);
        if (written === null) {
          await settle(state);
          break;
        }
        out.imported += written;
        state.windows = (state.windows ?? 0) + 1;
        out.windowsWritten += 1;
        await saveProgress(userId, progress);
      } catch (err) {
        if (isGarminKeyRefusal(err)) {
          await recordGarminSyncFailure(userId, err);
          out.failure = err;
          out.failures.push(step);
          break walk;
        }
        if (isGarminRateLimit(err)) {
          out.stopReason = "rate_limited";
          out.retryAfterMs = err.retryAfterMs;
          break walk;
        }
        // One resource's failure stays with it; the window is read again
        // next slice.
        out.failures.push(step);
        out.failure ??= err;
        getEvent()?.addWarning(
          `garmin backfill: ${step} before ${state.before} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue walk;
      }
    }
  }
  return out;
}

/**
 * Run one slice of the backfill for one account. Returns how many rows it
 * wrote and whether it sent the next slice.
 */
export async function runGarminBackfillForUser(
  userId: string,
  shouldStop: () => boolean = () => false,
  slice: number = 0,
  options: GarminBackfillSliceOptions = {},
): Promise<{ imported: number; continued: boolean }> {
  if (slice > GARMIN_BACKFILL_MAX_SLICE) {
    throw new Error(
      `garmin backfill for user ${userId} reached slice ${slice}, past the ceiling of ${GARMIN_BACKFILL_MAX_SLICE}`,
    );
  }
  const now = options.now ?? Date.now;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { garminBackfillProgress: true, garminBackfillCompletedAt: true },
  });
  if (!user || user.garminBackfillCompletedAt) {
    return { imported: 0, continued: false };
  }
  const creds = await getGarminCredentials(userId);
  if (!creds) {
    // Disconnected since the job was sent: nothing to read, and a reconnect
    // reopens the backfill.
    return { imported: 0, continued: false };
  }
  if (await isReauthRequired(userId, "garmin")) {
    annotate({
      action: { name: "garmin.backfill.skipped_reauth", details: { slice } },
    });
    return { imported: 0, continued: false };
  }

  const tz = await resolveUserTimezone(userId);
  const progress: GarminBackfillProgress = readGarminBackfillProgress(
    user.garminBackfillProgress,
  ) ?? { anchor: userDayKey(new Date(now()), tz), steps: {} };
  const session = new GarminSession({
    userId,
    apiKey: creds.apiKey,
    region: creds.region,
    transport: options.transport,
  });
  const walked = await walkSlice({
    userId,
    tz,
    progress,
    session,
    cycleAvailable: await isCycleAvailableForUser(userId),
    shouldStop,
    now,
    deadline: now() + (options.sliceMs ?? GARMIN_BACKFILL_SLICE_MS),
  });
  const { imported, windowsWritten, newlySettled, stopReason, failures } =
    walked;
  const { retryAfterMs, failure } = walked;

  try {
    await rememberGarminKeyExpiry(
      userId,
      session.learnedKeyExpiresAt,
      creds.keyExpiresAt,
    );
  } catch (err) {
    // A convenience; the backfill does not depend on it.
    getEvent()?.addWarning(`garmin backfill: key expiry note failed: ${err}`);
  }

  const settled = GARMIN_BACKFILL_STEPS.every((s) => progress.steps[s]?.done);
  annotate({
    meta: {
      "garmin.backfill.slice": {
        slice,
        stopReason,
        failures,
        windowsWritten,
        imported,
        historyStart: progress.historyStart ?? null,
        edges: Object.fromEntries(
          Object.entries(progress.steps).map(([n, s]) => [
            n,
            s!.done ? "done" : s!.before,
          ]),
        ),
      },
    },
  });
  reportJobProgress({
    garmin_backfill_slice: slice,
    garmin_backfill_windows: windowsWritten,
  });

  if (settled && stopReason === null && failures.length === 0) {
    await prisma.user.update({
      where: { id: userId },
      data: {
        garminBackfillCompletedAt: new Date(now()),
        garminBackfillProgress: garminBackfillProgressJson(progress),
      },
    });
    annotate({
      action: {
        name: "garmin.backfill.complete",
        details: { imported, slice },
      },
    });
    return { imported, continued: false };
  }

  if (isGarminKeyRefusal(failure)) {
    // Parked; a reconnect sends the next chain.
    return { imported, continued: false };
  }

  const progressed = windowsWritten > 0 || newlySettled > 0;
  if (progressed || stopReason === "rate_limited") {
    const delaySeconds =
      stopReason === "rate_limited"
        ? Math.max(
            INTEGRATION_BACKFILL_CONTINUATION_DELAY_SECONDS,
            retryAfterMs !== undefined
              ? Math.ceil(retryAfterMs / 1000)
              : GARMIN_BACKFILL_THROTTLED_DELAY_SECONDS,
          )
        : stopReason === "lane_wanted"
          ? LANE_YIELD_DELAY_SECONDS
          : INTEGRATION_BACKFILL_CONTINUATION_DELAY_SECONDS;
    if (await sendNextSlice(userId, slice, delaySeconds)) {
      annotate({
        action: {
          name: "garmin.backfill.continued",
          details: { slice, stopReason, windowsWritten, delaySeconds },
        },
      });
      return { imported, continued: true };
    }
  }

  throw new Error(
    `garmin backfill incomplete for user ${userId} (slice ${slice}${stopReason ? `, stopped on ${stopReason}` : ""}${failure instanceof Error ? `: ${failure.message}` : ""})`,
  );
}

async function sendNextSlice(
  userId: string,
  slice: number,
  delaySeconds: number,
): Promise<boolean> {
  if (slice + 1 > GARMIN_BACKFILL_MAX_SLICE) return false;
  const boss = getGlobalBoss();
  if (!boss) return false;
  const sent = await enqueueIntegrationBackfillAdmission(
    boss,
    {
      kind: "garmin-backfill",
      data: { userId, enqueuedAt: new Date().toISOString(), slice: slice + 1 },
    },
    delaySeconds,
  );
  return Boolean(sent);
}

/**
 * Boot-time discovery: every live account with a Garmin key whose backfill is
 * not stamped. Idempotent across reboots; errors come back in the result so
 * the worker boot never fails on a miss.
 */
export async function enqueueBootTimeGarminBackfill(
  startAfterSeconds: number = 0,
): Promise<{ enqueued: number; skipped: number; error: string | null }> {
  const boss = getGlobalBoss();
  if (!boss) return { enqueued: 0, skipped: 0, error: null };
  try {
    const users = await prisma.user.findMany({
      where: {
        garminBackfillCompletedAt: null,
        garminApiKeyEncrypted: { not: null },
        ...ACTIVE_ACCOUNT,
      },
      select: { id: true },
    });
    let enqueued = 0;
    let skipped = 0;
    for (const { id: userId } of users) {
      const payload: GarminBackfillPayload = {
        userId,
        enqueuedAt: new Date().toISOString(),
      };
      const jobId = await boss.send(
        GARMIN_BACKFILL_QUEUE,
        payload,
        integrationBackfillSourceOptions(
          `garmin-backfill|${userId}`,
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
