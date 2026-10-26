/**
 * v1.28.x — Strava API v3 sync.
 *
 * Pulls the athlete's activities and upserts each into the `Workout` table as
 * `source = STRAVA`, keyed on `(userId, source, externalId)` so a re-fetch /
 * `activity.update` overwrites in place. Strava is a WORKOUT source only — it
 * exposes no daily metrics, so unlike the Oura/Polar sync this writes `Workout`
 * rows and stops (no measurement rollup fold).
 *
 * Cross-source dedup is NOT done here: a Strava run and the same run via Apple
 * Health remain two distinct `Workout` rows (different `source`); the read-time
 * `pickCanonicalWorkoutRows` picker collapses the cross-source twin at read
 * time via the user's source-priority ladder. One engine, no parallel path.
 *
 * Token model: Strava ROTATES its refresh token on every refresh. The schema
 * has no expiry column, so the sync refreshes REACTIVELY — the first read that
 * 401s triggers one refresh (persisting BOTH rotated tokens via a compare-and-
 * set) and a single retry. A refresh Strava refuses for a dead token (a 400
 * whose fault names `RefreshToken`) records `reauth_required` on the `strava`
 * ledger; any other refusal is classified by its status.
 *
 * Rate limits: 200 req / 15 min + 2000 / day per app. The walk is page-bounded
 * (`walkPages`, which reports a walk cut off at its ceiling instead of
 * passing it off as the whole history) and the per-activity detail fetch (for `calories`, absent from the summary)
 * is budget-capped. A 429 mid-walk ends the walk where it stands: what was
 * read lands, the cursor moves only as far as an oldest-first walk proves, the
 * failure is booked transient, and the run reports how long Strava's headers
 * say to wait (`retryAfterSeconds`), which the backfill waits out before its
 * next run. It used to throw out of the walk and discard everything read.
 */
import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { emitInsertedWorkoutArrival } from "@/lib/arrivals/workout-emit";
import { invalidateUserMeasurements } from "@/lib/cache/invalidate";
import { annotate, getEvent } from "@/lib/logging/context";
import {
  markSyncFailureRecorded,
  recordSyncFailure,
  recordSyncSuccess,
  toFailureKind,
  type FailureKind,
} from "@/lib/integrations/status";
import { walkPages } from "@/lib/integrations/page-walk";
import { fetchActivities, fetchActivityById } from "./client";
import { mapActivity, summaryHasHeartRate, type StravaWorkoutRow } from "./map";
import { type StravaDetailedActivity } from "./wire-types";
import { getStravaConnection } from "./credentials";
import { refreshStravaAfterRefusal } from "./oauth-descriptor";
import {
  StravaApiError,
  classifyStravaError,
  isStravaRateLimited,
} from "./response-classifier";

/** Default first-incremental lookback (days) when no cursor exists yet. */
export const STRAVA_SYNC_LOOKBACK_DAYS = 30;

/** Overlap (ms) subtracted from the stored cursor on an incremental sync so an
 * activity uploaded late (started before the cursor, synced after) is still
 * caught. The upsert is idempotent, so re-fetching the overlap window is cheap. */
export const STRAVA_SYNC_OVERLAP_MS = 24 * 60 * 60 * 1000;

const PER_PAGE = 100;
const INCREMENTAL_MAX_PAGES = 5;
const BACKFILL_MAX_PAGES = 40;
/** Per-activity detail calls (for `calories`) are capped per sync to stay well
 * under Strava's 200-req / 15-min ceiling on a heavy backfill. */
const INCREMENTAL_DETAIL_BUDGET = 100;
const BACKFILL_DETAIL_BUDGET = 150;

export function classifyStravaFailure(err: unknown): FailureKind {
  return toFailureKind(classifyStravaError(err));
}

export async function recordStravaFailure(
  userId: string,
  err: unknown,
): Promise<void> {
  await recordSyncFailure({
    userId,
    integration: "strava",
    kind: classifyStravaFailure(err),
    message: err instanceof Error ? err.message : String(err),
    errorCode:
      err instanceof StravaApiError && err.httpStatus != null
        ? String(err.httpStatus)
        : undefined,
  });
}

export interface SyncUserStravaOptions {
  fullSync?: boolean;
  lookbackDays?: number;
}

/**
 * Sync one user's Strava activities. Returns the count of `Workout` rows
 * written. A user with no Strava connection is a clean no-op (returns 0,
 * touches no status row).
 */
export async function syncUserStrava(
  userId: string,
  opts: SyncUserStravaOptions = {},
): Promise<number> {
  return (await runStravaSync(userId, opts)).imported;
}

/** What one history run read, for the backfill to resume from. */
export interface StravaHistoryRun {
  imported: number;
  /**
   * The start of the oldest activity the run read, when the pages came
   * newest first as Strava serves a walk without `after`; null otherwise,
   * so a place is never recorded from pages in an order the resume does not
   * expect.
   */
  oldestStart: Date | null;
  /** Set when Strava's rate limit ended the run: seconds until it resets. */
  retryAfterSeconds?: number;
}

/**
 * One run of the full-history walk, from `before` (or the newest activity)
 * back as far as one run's page ceiling reaches.
 */
export async function syncStravaHistory(
  userId: string,
  before?: Date,
): Promise<StravaHistoryRun> {
  return runStravaSync(userId, { fullSync: true }, before);
}

async function runStravaSync(
  userId: string,
  opts: SyncUserStravaOptions,
  before?: Date,
): Promise<StravaHistoryRun> {
  const conn = await getStravaConnection(userId);
  if (!conn) return { imported: 0, oldestStart: null };

  const fullSync = opts.fullSync ?? false;
  const beforeEpoch =
    before === undefined ? undefined : Math.floor(before.getTime() / 1000);

  // Resolve the incremental cursor. On a full backfill we walk all history
  // (`after` omitted). Otherwise start at the stored newest-activity instant
  // minus the overlap, or a default lookback when no cursor exists yet.
  let afterEpoch: number | undefined;
  if (!fullSync) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { stravaLastActivityAt: true },
    });
    const lookbackMs =
      (opts.lookbackDays ?? STRAVA_SYNC_LOOKBACK_DAYS) * 24 * 60 * 60 * 1000;
    const base = user?.stravaLastActivityAt
      ? user.stravaLastActivityAt.getTime() - STRAVA_SYNC_OVERLAP_MS
      : Date.now() - lookbackMs;
    afterEpoch = Math.floor(base / 1000);
  }

  // Reactive refresh state — one refresh per sync, shared across every call.
  let accessToken = conn.accessToken;
  let refreshDone = false;

  async function refreshOnce(): Promise<boolean> {
    if (refreshDone) return false;
    const usable = await refreshStravaAfterRefusal(
      userId,
      conn!.refreshTokenCiphertext,
    );
    if (!usable) return false;
    accessToken = usable;
    refreshDone = true;
    return true;
  }

  async function authed<T>(fn: (token: string) => Promise<T>): Promise<T> {
    try {
      return await fn(accessToken);
    } catch (err) {
      if (
        err instanceof StravaApiError &&
        err.httpStatus === 401 &&
        (await refreshOnce())
      ) {
        return fn(accessToken);
      }
      throw err;
    }
  }

  const maxPages = fullSync ? BACKFILL_MAX_PAGES : INCREMENTAL_MAX_PAGES;
  let detailBudget = fullSync
    ? BACKFILL_DETAIL_BUDGET
    : INCREMENTAL_DETAIL_BUDGET;

  let rows: StravaWorkoutRow[];
  let newestStart: Date | null = null;
  let oldestStart: Date | null = null;
  let previousStart: number | null = null;
  let newestFirst = true;
  // Assigned inside the page callback; the cast keeps the compiler from
  // narrowing it to its initial `null` after the walk.
  let rateLimited = null as StravaApiError | null;

  try {
    // Strava pages by number; a short page is the last one. A walk that
    // reaches its ceiling with a full page last reports itself truncated, and
    // the backfill leaves its marker unset (`integrations/page-walk.ts`).
    const walk = await walkPages<number, StravaWorkoutRow>(
      "strava.activities",
      maxPages,
      async (cursor) => {
        const page = cursor ?? 1;
        let activities: Awaited<ReturnType<typeof fetchActivities>>;
        try {
          activities = await authed((t) =>
            fetchActivities(t, {
              after: afterEpoch,
              before: beforeEpoch,
              page,
              perPage: PER_PAGE,
            }),
          );
        } catch (err) {
          if (!isStravaRateLimited(err)) throw err;
          rateLimited = err;
          return { items: [], next: null, interrupted: true };
        }
        const mapped: StravaWorkoutRow[] = [];
        for (const a of activities) {
          // Fetch detail only to fill `calories` (absent from the summary),
          // and only while the budget allows. When the summary already lacks
          // HR we also let the detail top it up. A detail failure is
          // non-fatal — map from the summary — but a 429 ends the walk here,
          // keeping the activities before this one.
          let detail: StravaDetailedActivity | null = null;
          if (detailBudget > 0) {
            try {
              detail = await authed((t) => fetchActivityById(t, a.id));
              detailBudget -= 1;
            } catch (err) {
              if (isStravaRateLimited(err)) {
                rateLimited = err;
                return { items: mapped, next: null, interrupted: true };
              }
              getEvent()?.addWarning(
                `strava: activity detail fetch failed for ${a.id}: ${err}`,
              );
              detail = null;
            }
          } else if (!summaryHasHeartRate(a)) {
            getEvent()?.addWarning(
              `strava: detail budget exhausted; mapping activity ${a.id} from summary only`,
            );
          }

          const row = mapActivity(a, detail);
          if (row) {
            mapped.push(row);
            if (a.start_date) {
              const d = new Date(a.start_date);
              if (!Number.isNaN(d.getTime())) {
                if (!newestStart || d > newestStart) newestStart = d;
                if (!oldestStart || d < oldestStart) oldestStart = d;
                if (previousStart !== null && d.getTime() > previousStart) {
                  newestFirst = false;
                }
                previousStart = d.getTime();
              }
            }
          }
        }
        return {
          items: mapped,
          next: activities.length < PER_PAGE ? null : page + 1,
        };
      },
      1,
    );
    rows = walk.items;
  } catch (err) {
    await recordStravaFailure(userId, err);
    throw markSyncFailureRecorded(err);
  }

  // A walk the rate limit ended is a prefix of the pages in the order Strava
  // served them. Oldest first (an incremental walk), every activity up to the
  // newest one read is in; newest first, older ones are still missing, and
  // moving the cursor would skip them for good.
  const cursorSafe = rateLimited === null || !newestFirst;

  let imported: number;
  try {
    imported = await upsertStravaWorkouts(userId, rows);

    // Advance the incremental cursor to the newest activity start we saw, but
    // never move it backwards (a bounded backfill page-walk may not reach the
    // very newest activity in one pass).
    if (newestStart && cursorSafe) {
      await prisma.user.updateMany({
        where: {
          id: userId,
          OR: [
            { stravaLastActivityAt: null },
            { stravaLastActivityAt: { lt: newestStart } },
          ],
        },
        data: { stravaLastActivityAt: newestStart },
      });
    }
  } catch (err) {
    await recordStravaFailure(userId, err);
    throw markSyncFailureRecorded(err);
  }

  if (rateLimited) {
    // Not finished, so no success; booked transient, the next run goes on.
    await recordStravaFailure(userId, rateLimited);
    if (imported > 0) invalidateUserMeasurements(userId);
    annotate({
      action: {
        name: "strava.sync.rate_limited",
        details: {
          imported,
          retry_after_seconds: rateLimited.retryAfterSeconds ?? null,
        },
      },
    });
    return {
      imported,
      oldestStart: newestFirst ? oldestStart : null,
      retryAfterSeconds: rateLimited.retryAfterSeconds,
    };
  }

  await recordSyncSuccess(userId, "strava");

  // Background-sync posture: sweep the workouts cache and mark the analytics
  // cells stale (workouts feed achievements + analytics) so the upserted rows
  // reach the cached readers, matching the `/api/workouts/batch` writer.
  if (imported > 0) {
    invalidateUserMeasurements(userId);
  }

  annotate({
    action: { name: "strava.sync.complete", details: { imported } },
  });
  return { imported, oldestStart: newestFirst ? oldestStart : null };
}

/**
 * The update for a row mapped from the summary alone. Calories, the
 * description and (when the summary has none) the heart rate come only from
 * the detail read, so their absence here says nothing: the stored values stay.
 * A detail read that did run is written as it came, nulls included.
 */
async function summaryOnlyUpdate<
  D extends {
    totalEnergyKcal: number | null;
    avgHeartRate: number | null;
    maxHeartRate: number | null;
    metadata: Prisma.InputJsonValue;
  },
>(data: D, stored: { metadata: Prisma.JsonValue } | null) {
  const { totalEnergyKcal, avgHeartRate, maxHeartRate, metadata, ...rest } =
    data;
  const storedMeta =
    stored?.metadata && typeof stored.metadata === "object"
      ? (stored.metadata as Record<string, unknown>)
      : {};
  const description = storedMeta.stravaDescription;
  return {
    ...rest,
    ...(totalEnergyKcal != null ? { totalEnergyKcal } : {}),
    ...(avgHeartRate != null ? { avgHeartRate } : {}),
    ...(maxHeartRate != null ? { maxHeartRate } : {}),
    metadata:
      typeof description === "string"
        ? ({
            ...(metadata as Record<string, unknown>),
            stravaDescription: description,
          } as Prisma.InputJsonValue)
        : metadata,
  };
}

/**
 * Upsert a batch of mapped Strava activities into `Workout`, keyed on
 * `(userId, source = STRAVA, externalId)` so a re-fetch overwrites in place.
 * `(userId, source = STRAVA, externalId)` so replays overwrite in place.
 * Failed rows are logged while the rest of the batch is attempted, then the
 * first error is rethrown so the caller cannot advance its cursor or backfill
 * watermark past a partially persisted batch.
 */
export async function upsertStravaWorkouts(
  userId: string,
  rows: readonly StravaWorkoutRow[],
): Promise<number> {
  if (rows.length === 0) return 0;

  let imported = 0;
  let firstError: unknown;
  let hadError = false;
  for (const r of rows) {
    const data = {
      sportType: r.sportType,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      durationSec: r.durationSec,
      totalEnergyKcal: r.totalEnergyKcal,
      totalDistanceM: r.totalDistanceM,
      avgHeartRate: r.avgHeartRate,
      maxHeartRate: r.maxHeartRate,
      elevationM: r.elevationM,
      metadata: r.metadata,
    };
    try {
      const [inserted] = await prisma.workout.createManyAndReturn({
        data: {
          userId,
          source: "STRAVA",
          externalId: r.externalId,
          ...data,
        },
        skipDuplicates: true,
        select: { id: true, startedAt: true },
      });
      if (inserted) {
        void emitInsertedWorkoutArrival(userId, inserted, "strava").catch(
          () => {},
        );
      } else {
        const where = {
          userId_source_externalId: {
            userId,
            source: "STRAVA" as const,
            externalId: r.externalId,
          },
        };
        await prisma.workout.update({
          where,
          data: r.summaryOnly
            ? await summaryOnlyUpdate(
                data,
                await prisma.workout.findUnique({
                  where,
                  select: { metadata: true },
                }),
              )
            : data,
        });
      }
      imported += 1;
    } catch (err) {
      getEvent()?.addWarning(`strava: failed to upsert workout: ${err}`);
      if (!hadError) {
        firstError = err;
        hadError = true;
      }
    }
  }
  if (hadError) throw firstError;

  annotate({
    action: { name: "strava.workout.ingest", details: { imported } },
  });
  return imported;
}
