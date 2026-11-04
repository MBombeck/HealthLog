/**
 * Garmin Personal API sync: the hourly incremental read, and the resource
 * readers the history backfill (`src/lib/jobs/garmin-backfill.ts`) shares.
 *
 * Resources, each read over a window of the user's calendar days and chunked
 * to the resource's documented maximum (`GARMIN_RANGE_DAYS`):
 *
 *   daily       `v2/dailysummaries`      steps, distance, floors, active kcal,
 *                                        resting HR, stress level, Body Battery
 *   sleep       sleep summaries          stage minutes, sleep score, SpO2,
 *                                        breathing rate
 *   hrv         HRV daily summaries      overnight RMSSD
 *   weight      weight range (all)       weight and body composition
 *   activities  activity search (paged)  workouts
 *
 * plus the menstrual-cycle summary of today, best-effort and off the ledger
 * (`./cycle-sync.ts`). Rows are tagged `source = GARMIN`; the measurement
 * write goes through the shared reconciler, so a re-read of the same day
 * overwrites in place (Garmin finalises a night's figures after waking).
 *
 * The resources are read one after another, not in parallel: the Personal
 * API is a per-person allowance, and a rate limit stops the run on the spot
 * (the remaining resources wait for the next tick) rather than spending more
 * requests into it. A refused key stops the run too and parks the connection
 * at `reauth_required`; nothing else can fix it but a new key.
 */
import { prisma } from "@/lib/db";
import type { MeasurementType } from "@/generated/prisma/client";
import { annotate, getEvent } from "@/lib/logging/context";
import {
  getIntegrationStatus,
  isReauthRequired,
  markReconnected,
  markSyncFailureRecorded,
  recordSyncFailure,
  recordSyncSuccess,
  toFailureKind,
  type FailureKind,
} from "@/lib/integrations/status";
import { classifyIntegrationError } from "@/lib/integrations/http-status-classifier";
import type { InsertedMeasurementArrivalRow } from "@/lib/arrivals/measurement-emit";
import { invalidateUserMeasurements } from "@/lib/cache/invalidate";
import { afterProviderWrite } from "@/lib/integrations/sync-kit/after-write";
import { afterMeasurementMutation } from "@/lib/rollups/after-measurement-mutation";
import type { SyncWriteResult } from "@/lib/outcome/written-outcome";
import { maybeEnqueueMorningRefresh } from "@/lib/daily/morning-refresh-trigger";
import { walkPages } from "@/lib/integrations/page-walk";
import {
  MeasurementReconciliationError,
  reconcileExternalMeasurement,
} from "@/lib/measurements/reconcile-external-measurement";
import { shiftDateKey, userDayKey } from "@/lib/tz/format";
import { resolveUserTimezone } from "@/lib/tz/resolver";

import {
  chunkGarminRange,
  exchangeGarminKey,
  shiftGarminDay,
  GARMIN_ACTIVITY_PAGE,
  GARMIN_PATHS,
  GARMIN_RANGE_DAYS,
  GarminApiError,
  GarminSession,
  isGarminKeyRefusal,
  isGarminRateLimit,
  type GarminRegion,
  type GarminTransport,
} from "./client";
import { getGarminCredentials, rememberGarminKeyExpiry } from "./credentials";
import { syncGarminCycle } from "./cycle-sync";
import {
  garminUnavailableCode,
  markGarminResourceUnavailable,
  readGarminUnavailable,
} from "./unavailable";
import {
  mapGarminDailySummary,
  mapGarminHrv,
  mapGarminSleep,
  mapGarminWeightRange,
  type GarminMappedMeasurement,
} from "./map";
import {
  mapGarminActivity,
  upsertGarminWorkouts,
  type GarminWorkoutRow,
} from "./sync-workouts";
import type {
  GarminActivity,
  GarminDailySummaryEnvelope,
  GarminHrvEnvelope,
  GarminSleepSummary,
  GarminWeightRangeEnvelope,
} from "./wire-types";

export const GARMIN_RESOURCES = [
  "daily",
  "sleep",
  "hrv",
  "weight",
  "activities",
] as const;

export type GarminResource = (typeof GARMIN_RESOURCES)[number];

/** The widest single request per resource, in calendar days. */
export const GARMIN_RESOURCE_WINDOW_DAYS: Record<GarminResource, number> = {
  daily: GARMIN_RANGE_DAYS.dailySummaries,
  sleep: GARMIN_RANGE_DAYS.sleepSummaries,
  hrv: GARMIN_RANGE_DAYS.hrvDaily,
  weight: GARMIN_RANGE_DAYS.weightRange,
  activities: GARMIN_RANGE_DAYS.activities,
};

/** Floor of the incremental window: covers Garmin's re-scoring of recent nights. */
export const GARMIN_SYNC_LOOKBACK_DAYS = 7;

/**
 * Ceiling of the incremental window. A longer gap is history and belongs to
 * the backfill, which a connect starts and boot discovery resumes.
 */
export const GARMIN_SYNC_MAX_LOOKBACK_DAYS = 30;

/** Upper bound on pages of one activity window (99 each). */
const MAX_ACTIVITY_PAGES = 50;

/** Readings per write transaction. */
const WRITE_CHUNK = 400;

const DAY_MS = 24 * 60 * 60 * 1000;

export function classifyGarminFailure(err: unknown): FailureKind {
  return toFailureKind(classifyIntegrationError(err, "Garmin"));
}

/**
 * Record a whole-connection Garmin failure on the `garmin` ledger with its
 * classification and HTTP code. The message is Garmin's status and verb,
 * never a body and never the key: `GarminApiError` is built from neither.
 */
export async function recordGarminSyncFailure(
  userId: string,
  err: unknown,
): Promise<void> {
  await recordSyncFailure({
    userId,
    integration: "garmin",
    kind: classifyGarminFailure(err),
    message:
      err instanceof GarminApiError
        ? err.message
        : err instanceof Error
          ? err.name
          : "unknown_error",
    errorCode:
      err instanceof GarminApiError && err.httpStatus != null
        ? String(err.httpStatus)
        : undefined,
  });
}

/** What one resource window yields. */
export interface GarminWindowRead {
  measurements: GarminMappedMeasurement[];
  workouts: GarminWorkoutRow[];
  /** Oldest day the window returned real data for. */
  oldestDay?: string;
  /**
   * Sleep only: days of the window Garmin answered for without a night (the
   * night was deleted, or reduced to a nap). Their earlier rows are retired.
   */
  sleepEmptyDays: string[];
}

function minDay(
  a: string | undefined,
  b: string | undefined,
): string | undefined {
  if (b === undefined) return a;
  return a === undefined || b < a ? b : a;
}

/** Every calendar day from `start` to `end`, both included. */
export function garminDaysBetween(start: string, end: string): string[] {
  const days: string[] = [];
  for (let d = start; d <= end; d = shiftGarminDay(d, 1)) days.push(d);
  return days;
}

/**
 * Retire what earlier syncs imported for nights Garmin no longer reports (a
 * night deleted in Garmin Connect, or reduced to a nap): every live GARMIN
 * row keyed under `sleep:<day>:`, whatever its type, because the stages and
 * the night's scalars all came from that night. Soft delete, then the shared
 * tail refolds the touched days. Best-effort: the day stays inside the
 * window, so the next run retries it.
 */
export async function retireGarminSleepDays(
  userId: string,
  days: readonly string[],
): Promise<number> {
  const prefixes = days
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .map((d) => `sleep:${d}:`);
  if (prefixes.length === 0) return 0;
  try {
    const rows = await prisma.measurement.findMany({
      where: {
        userId,
        source: "GARMIN",
        deletedAt: null,
        OR: prefixes.map((prefix) => ({ externalId: { startsWith: prefix } })),
      },
      select: { id: true, type: true, measuredAt: true },
    });
    if (rows.length === 0) return 0;
    const res = await prisma.measurement.updateMany({
      where: { userId, id: { in: rows.map((r) => r.id) }, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    await afterMeasurementMutation(userId, rows, {
      source: "sync",
      label: "garmin",
    });
    invalidateUserMeasurements(userId);
    annotate({ meta: { garmin_sleep_retired_rows: res.count } });
    return res.count;
  } catch (err) {
    getEvent()?.addWarning(
      `garmin: retiring removed nights failed for ${userId}: ${err}`,
    );
    return 0;
  }
}

async function readActivities(
  session: GarminSession,
  window: { startDate: string; endDate: string },
): Promise<GarminActivity[]> {
  // Offset paging: the cursor is the next `start`; a short page is the last.
  const walk = await walkPages<number, GarminActivity>(
    "garmin.activities",
    MAX_ACTIVITY_PAGES,
    async (cursor) => {
      const start = cursor ?? 0;
      const body = await session.get<
        GarminActivity[] | { activityList?: GarminActivity[] }
      >("activities", GARMIN_PATHS.activities, {
        startDate: window.startDate,
        endDate: window.endDate,
        start,
        limit: GARMIN_ACTIVITY_PAGE,
        excludeChildren: true,
        sortOrder: "desc",
      });
      const items = Array.isArray(body)
        ? body
        : Array.isArray(body?.activityList)
          ? body.activityList
          : [];
      return {
        items,
        next:
          items.length < GARMIN_ACTIVITY_PAGE
            ? null
            : start + GARMIN_ACTIVITY_PAGE,
      };
    },
  );
  return walk.items;
}

/**
 * Read and map one window of one resource. The window may be wider than the
 * resource's maximum; it is chunked here.
 */
export async function readGarminWindow(
  session: GarminSession,
  resource: GarminResource,
  window: { startDate: string; endDate: string },
  tz: string,
): Promise<GarminWindowRead> {
  const out: GarminWindowRead = {
    measurements: [],
    workouts: [],
    sleepEmptyDays: [],
  };
  const chunks = chunkGarminRange(
    window.startDate,
    window.endDate,
    GARMIN_RESOURCE_WINDOW_DAYS[resource],
  );
  for (const chunk of chunks) {
    switch (resource) {
      case "daily": {
        const env = await session.get<GarminDailySummaryEnvelope>(
          "dailySummaries",
          GARMIN_PATHS.dailySummaries,
          chunk,
        );
        for (const d of env?.data ?? []) {
          const rows = mapGarminDailySummary(d, tz);
          if (rows.length > 0) {
            out.measurements.push(...rows);
            out.oldestDay = minDay(out.oldestDay, d.calendarDate ?? undefined);
          }
        }
        break;
      }
      case "sleep": {
        const nights = await session.get<
          GarminSleepSummary[] | GarminSleepSummary
        >("sleepSummaries", GARMIN_PATHS.sleepSummaries, chunk);
        const list = Array.isArray(nights) ? nights : nights ? [nights] : [];
        const nightDays = new Set<string>();
        for (const night of list) {
          const rows = mapGarminSleep(night, tz);
          if (rows.length > 0) {
            out.measurements.push(...rows);
            nightDays.add(night.calendarDate!);
            out.oldestDay = minDay(
              out.oldestDay,
              night.calendarDate ?? undefined,
            );
          }
        }
        // Garmin answers one entry per day, a night or an empty placeholder.
        // An answer with no entries at all is not trusted to say anything.
        if (list.length > 0) {
          for (const day of garminDaysBetween(chunk.startDate, chunk.endDate)) {
            if (!nightDays.has(day)) out.sleepEmptyDays.push(day);
          }
        }
        break;
      }
      case "hrv": {
        const env = await session.get<GarminHrvEnvelope>(
          "hrvDaily",
          `${GARMIN_PATHS.hrvDaily}/${chunk.startDate}/${chunk.endDate}`,
        );
        out.measurements.push(...mapGarminHrv(env, tz));
        break;
      }
      case "weight": {
        const env = await session.get<GarminWeightRangeEnvelope>(
          "weightRange",
          `${GARMIN_PATHS.weightRange}/${chunk.startDate}/${chunk.endDate}`,
          { includeAll: true },
        );
        out.measurements.push(...mapGarminWeightRange(env));
        break;
      }
      case "activities": {
        for (const a of await readActivities(session, chunk)) {
          const row = mapGarminActivity(a);
          if (!row) continue;
          out.workouts.push(row);
          out.oldestDay = minDay(out.oldestDay, userDayKey(row.startedAt, tz));
        }
        break;
      }
    }
  }
  return out;
}

/**
 * Write mapped Garmin readings through the shared reconciler, in chunks so a
 * year of daily summaries never rides one long transaction. Returns how many
 * readings were written (the plausibility gate's refusals are not counted).
 */
export async function upsertGarminMeasurements(
  userId: string,
  readings: readonly GarminMappedMeasurement[],
  opts: {
    emitArrivals?: boolean;
    onInserted?: (rows: InsertedMeasurementArrivalRow[]) => void;
  } = {},
): Promise<number> {
  if (readings.length === 0) return 0;
  let imported = 0;
  const touched: Array<{ type: MeasurementType; measuredAt: Date }> = [];
  const insertedRows: InsertedMeasurementArrivalRow[] = [];

  for (let i = 0; i < readings.length; i += WRITE_CHUNK) {
    const chunk = readings.slice(i, i + WRITE_CHUNK);
    const verdicts = await prisma.$transaction(
      async (tx) => {
        const outcomes = [];
        for (const r of chunk) {
          const verdict = await reconcileExternalMeasurement(
            tx,
            {
              userId,
              type: r.type as MeasurementType,
              source: "GARMIN",
              value: r.value,
              unit: r.unit,
              measuredAt: r.measuredAt,
              externalId: r.externalId,
              sleepStage: r.sleepStage ?? null,
              deviceType: r.deviceType ?? null,
            },
            { exactExternalMatch: "update" },
          );
          if (verdict.status === "failed") {
            throw new MeasurementReconciliationError(verdict);
          }
          outcomes.push(verdict);
        }
        return outcomes;
      },
      { timeout: 60_000 },
    );
    chunk.forEach((reading, index) => {
      const verdict = verdicts[index]!;
      if (verdict.status === "rejected_range") return;
      for (const dirty of verdict.dirtyIdentities ?? []) touched.push(dirty);
      imported += 1;
      touched.push({
        type: reading.type as MeasurementType,
        measuredAt: reading.measuredAt,
      });
      if (verdict.status === "inserted") insertedRows.push(verdict.row);
    });
  }

  opts.onInserted?.(insertedRows);
  await afterProviderWrite({
    userId,
    provider: "garmin",
    touched,
    ...(opts.emitArrivals !== false
      ? { arrivals: { rows: insertedRows, source: "garmin" } }
      : {}),
  });
  return imported;
}

/** Ceiling of a catch-up after an outage, from the last successful sync. */
export const GARMIN_SYNC_CATCHUP_MAX_DAYS = 365;

/**
 * How far back this tick reaches. Three bounds, the widest wins:
 *
 *   - the re-score floor (`GARMIN_SYNC_LOOKBACK_DAYS`);
 *   - the newest Garmin row held, plus a day of overlap, up to the 30-day
 *     ceiling, for data a watch uploads days late while syncs still succeed;
 *   - the last successful sync, plus a day, up to a year, so an outage of
 *     any length short of that closes without a gap once the key works
 *     again.
 *
 * A connection that never succeeded takes the 30-day ceiling; the backfill
 * reads the rest.
 */
export async function resolveGarminLookbackDays(
  userId: string,
  now: number = Date.now(),
): Promise<number> {
  const [newest, status] = await Promise.all([
    prisma.measurement.findFirst({
      where: { userId, source: "GARMIN", deletedAt: null },
      orderBy: { measuredAt: "desc" },
      select: { measuredAt: true },
    }),
    getIntegrationStatus(userId, "garmin"),
  ]);
  const since = (at: number) => Math.floor((now - at) / DAY_MS) + 1;
  if (!newest && !status.lastSuccessAt) return GARMIN_SYNC_MAX_LOOKBACK_DAYS;
  const fromData = newest
    ? Math.min(
        GARMIN_SYNC_MAX_LOOKBACK_DAYS,
        since(newest.measuredAt.getTime()),
      )
    : GARMIN_SYNC_MAX_LOOKBACK_DAYS;
  const fromSuccess = status.lastSuccessAt
    ? Math.min(
        GARMIN_SYNC_CATCHUP_MAX_DAYS,
        since(Date.parse(status.lastSuccessAt)),
      )
    : GARMIN_SYNC_MAX_LOOKBACK_DAYS;
  return Math.max(GARMIN_SYNC_LOOKBACK_DAYS, fromData, fromSuccess);
}

export interface GarminSyncOptions {
  lookbackDays?: number;
  /** Skip a connection parked on a refused key (the hourly cohort does). */
  skipWhenParked?: boolean;
  /** Test seam: the transport the session uses. */
  transport?: GarminTransport;
}

/**
 * Sync one account's recent Garmin data. `imported` counts rows written
 * (measurements and workouts); `failed` is true when a resource did not
 * settle. An account without a key is a clean no-op.
 */
export async function syncUserGarmin(
  userId: string,
  opts: GarminSyncOptions = {},
): Promise<SyncWriteResult> {
  const creds = await getGarminCredentials(userId);
  if (!creds) return { imported: 0, failed: false };
  if (opts.skipWhenParked && (await isReauthRequired(userId, "garmin"))) {
    const probed = await reprobeParkedGarminKey(userId, creds, opts.transport);
    if (!probed) return { imported: 0, failed: false };
  }

  const tz = await resolveUserTimezone(userId);
  const today = userDayKey(new Date(), tz);
  const lookbackDays =
    opts.lookbackDays ?? (await resolveGarminLookbackDays(userId));
  const window = {
    startDate: shiftDateKey(today, -lookbackDays),
    endDate: today,
  };
  const session = new GarminSession({
    userId,
    apiKey: creds.apiKey,
    region: creds.region,
    transport: opts.transport,
  });
  const unavailable = await readGarminUnavailable(userId);

  let imported = 0;
  const failures: Array<{ resource: GarminResource; err: unknown }> = [];
  let insertedSleep: Date[] = [];

  for (const resource of GARMIN_RESOURCES) {
    if (unavailable.has(resource)) continue;
    try {
      const read = await readGarminWindow(session, resource, window, tz);
      if (resource === "sleep") {
        await retireGarminSleepDays(userId, read.sleepEmptyDays);
      }
      imported += await upsertGarminMeasurements(userId, read.measurements, {
        onInserted: (rows) => {
          if (resource !== "sleep") return;
          insertedSleep = rows
            .filter((row) => row.type === "SLEEP_DURATION")
            .map((row) => row.measuredAt);
        },
      });
      imported += await upsertGarminWorkouts(userId, read.workouts);
    } catch (err) {
      if (isGarminKeyRefusal(err)) {
        // The key is gone: nothing else in this run can succeed.
        await recordGarminSyncFailure(userId, err);
        throw markSyncFailureRecorded(err);
      }
      const code = garminUnavailableCode(resource, err);
      if (code) {
        // Garmin will not serve this resource to this account: noted once,
        // skipped from now on, and not a failure of the connection.
        await markGarminResourceUnavailable(userId, resource, code, today);
        continue;
      }
      failures.push({ resource, err });
      getEvent()?.addWarning(
        `garmin: ${resource} failed for ${userId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      // A rate limit is for the whole allowance: stop asking until next tick.
      if (isGarminRateLimit(err)) break;
    }
  }

  // Best-effort and off the ledger, whatever happens: most accounts track no
  // cycle in Garmin, and a refusal here never parks the connection.
  if (
    !unavailable.has("cycle") &&
    !failures.some((f) => isGarminRateLimit(f.err))
  ) {
    try {
      await syncGarminCycle(userId, session, today);
    } catch (err) {
      const code = garminUnavailableCode("cycle", err);
      if (code) {
        await markGarminResourceUnavailable(userId, "cycle", code, today);
      }
      getEvent()?.addWarning(
        `garmin: cycle import skipped for ${userId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  try {
    await rememberGarminKeyExpiry(
      userId,
      session.learnedKeyExpiresAt,
      creds.keyExpiresAt,
      { exchanged: session.proven },
    );
  } catch (err) {
    getEvent()?.addWarning(`garmin: key expiry note failed: ${err}`);
  }

  void maybeEnqueueMorningRefresh(userId, insertedSleep).catch(() => {});
  if (imported > 0) invalidateUserMeasurements(userId);
  annotate({
    meta: {
      "garmin.sync": {
        lookbackDays,
        imported,
        exchanges: session.exchanges,
        failures: failures.map((f) => f.resource),
        skipped: [...unavailable],
      },
    },
  });

  if (failures.length > 0) {
    const first = failures[0]!.err;
    await recordSyncFailure({
      userId,
      integration: "garmin",
      kind: classifyGarminFailure(first),
      message: `partial sync failure (${failures.map((f) => f.resource).join(", ")}): ${
        first instanceof GarminApiError ? first.message : "error"
      }`,
      errorCode:
        first instanceof GarminApiError && first.httpStatus != null
          ? String(first.httpStatus)
          : undefined,
    });
    return { imported, failed: true };
  }

  await recordSyncSuccess(userId, "garmin");
  return { imported, failed: false };
}

/** How long a parked key waits between two probes. */
export const GARMIN_REPROBE_INTERVAL_MS = DAY_MS;

/**
 * A key parked on a refusal is asked about again once a day: one token
 * exchange, nothing else. A refusal can be a passing one (a firewall's 403,
 * a 401 while Garmin rotates something), and without a probe such a key
 * stayed parked until the person pasted it again. Accepted, the connection
 * is reconnected and the run goes on; refused, the refusal is recorded,
 * which also dates the next probe. Returns whether the run should go on.
 */
export async function reprobeParkedGarminKey(
  userId: string,
  creds: { apiKey: string; region: GarminRegion },
  transport?: GarminTransport,
  now: number = Date.now(),
): Promise<boolean> {
  const status = await getIntegrationStatus(userId, "garmin");
  const last = status.lastAttemptAt ? Date.parse(status.lastAttemptAt) : 0;
  if (now - last < GARMIN_REPROBE_INTERVAL_MS) {
    annotate({ action: { name: "garmin.sync.skipped_reauth" } });
    return false;
  }
  try {
    await exchangeGarminKey(creds.apiKey, creds.region, transport);
  } catch (err) {
    await recordGarminSyncFailure(userId, err);
    annotate({ action: { name: "garmin.reprobe.refused" } });
    return false;
  }
  await markReconnected(userId, "garmin");
  annotate({ action: { name: "garmin.reprobe.accepted" } });
  return true;
}
