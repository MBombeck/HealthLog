/**
 * Garmin activity files → the heart-rate series (and, on opt-in, the GPS
 * track) of the Garmin workouts the activity list already wrote.
 *
 * The activity list (`activitylist-service`) gives a summary per activity:
 * duration, distance, energy, average and peak heart rate. The curve over the
 * session is only in the activity's original file, which the Personal API
 * serves at `GET /download-service/files/activity/{activityId}` as the same
 * one-member ZIP Garmin Connect's "Export original" hands out. Each file goes
 * through the importer's own pipeline (`src/lib/fit/`): unwrap, structural
 * scan and checksums, decode, map. Only the series and the track are kept,
 * and only for the stored Garmin workout the file belongs to
 * (`enrichOnly`): the summary row stays the activity list's.
 *
 * Cost is one request per activity, so the pass is small and late:
 *   - only Garmin workouts written in the last day (`createdAt`) that started
 *     in the last 30 days and have no series yet: new activities, not the
 *     history the backfill walks;
 *   - at most `GARMIN_ACTIVITY_FILES_PER_SYNC` downloads per sync;
 *   - an activity is asked for once per process and day, whatever came back
 *     (a file without records would otherwise be fetched every hour);
 *   - a refusal of the download itself (403, any 4xx but 404) pauses the
 *     pass for the account for a day; a rate limit or a refused key ends it
 *     for this sync. None of it fails the sync or touches the connection's
 *     status: the summaries are already stored.
 *
 * Older activities gain their curve when the person imports the file by hand
 * on the import page, which finds the stored Garmin workout the same way.
 */
import { prisma } from "@/lib/db";
import { FIT_UPLOAD_MAX_BYTES, unwrapFitUpload } from "@/lib/fit/container";
import { FitImportError } from "@/lib/fit/errors";
import { validateFitDrafts } from "@/lib/fit/import";
import { mapFitActivity } from "@/lib/fit/map";
import { decodeFitFile } from "@/lib/fit/parse";
import { annotate, getEvent } from "@/lib/logging/context";
import { ingestWorkoutBatch } from "@/lib/workouts/batch-ingest/ingest";
import { WORKOUT_DUPLICATE_WINDOW_MS } from "@/lib/measurements/pick-canonical-workout-rows";

import {
  GARMIN_PATHS,
  GarminApiError,
  isGarminKeyRefusal,
  isGarminRateLimit,
  type GarminSession,
} from "./client";

/** Downloads per sync. */
export const GARMIN_ACTIVITY_FILES_PER_SYNC = 5;

/** A workout is a candidate for this long after it was written. */
const CANDIDATE_WRITTEN_WITHIN_MS = 24 * 60 * 60 * 1000;
/** ... and only when it started within this many days. */
const CANDIDATE_STARTED_WITHIN_MS = 30 * 24 * 60 * 60 * 1000;
/** How long an activity is not asked for again, and a refusal pauses. */
const RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

/** The audit action of an attached activity file. */
export const GARMIN_ACTIVITY_FILE_AUDIT_ACTION = "workout.garmin.activity_file";

/** Activities already asked for, by `userId:activityId`, with the time. */
const askedAt = new Map<string, number>();
/** Accounts whose downloads Garmin refused, until when. */
const refusedUntil = new Map<string, number>();

/** Forget the in-process memory (tests). */
export function clearGarminActivityFileMemory(): void {
  askedAt.clear();
  refusedUntil.clear();
}

function prune(now: number): void {
  for (const [key, at] of askedAt) {
    if (now - at > RETRY_AFTER_MS) askedAt.delete(key);
  }
  for (const [key, until] of refusedUntil) {
    if (until <= now) refusedUntil.delete(key);
  }
}

export interface GarminActivityFileCounts {
  /** Files downloaded. */
  fetched: number;
  /** Workouts that gained a series or a track. */
  attached: number;
  /** Files that could not be read or matched to their workout. */
  unusable: number;
  /** Why the pass stopped early, if it did. */
  stopped?: "rate_limited" | "refused" | "key_refused";
}

/**
 * Attach one downloaded file to its stored Garmin workout. Answers whether
 * a series or a track landed.
 */
export async function attachGarminActivityFile(input: {
  userId: string;
  activityId: string;
  workoutStartedAt: Date;
  file: Uint8Array;
  keepRoutes: boolean;
  sourcePriorityJson: unknown;
}): Promise<boolean> {
  const { fit } = unwrapFitUpload(Buffer.from(input.file));
  const { decoded } = await decodeFitFile(fit);
  const mapped = mapFitActivity(decoded, {
    externalIdFor: () => input.activityId,
    keepRoutes: input.keepRoutes,
  });
  // A multisport file holds one session per leg; the stored workout is the
  // one that starts with it.
  const at = input.workoutStartedAt.getTime();
  const draft = mapped.drafts
    .filter(
      (d) =>
        Math.abs(Date.parse(d.startedAt) - at) < WORKOUT_DUPLICATE_WINDOW_MS,
    )
    .sort(
      (a, b) =>
        Math.abs(Date.parse(a.startedAt) - at) -
        Math.abs(Date.parse(b.startedAt) - at),
    )[0];
  if (!draft) return false;
  const { entries } = validateFitDrafts([draft]);
  if (entries.length === 0) return false;
  const result = await ingestWorkoutBatch({
    userId: input.userId,
    scoped: false,
    keepRoutes: input.keepRoutes,
    sourcePriorityJson: input.sourcePriorityJson,
    workouts: entries,
    refusedSampleIndices: new Set(),
    ipAddress: null,
    sourceOverride: "GARMIN",
    enrichOnly: true,
    auditAction: GARMIN_ACTIVITY_FILE_AUDIT_ACTION,
  });
  return result.entries[0]?.status === "enriched";
}

/** The activity id Garmin takes in the path: a 64-bit integer. */
const ACTIVITY_ID = /^\d{1,20}$/;

/**
 * Download and attach the files of the account's new Garmin workouts.
 * Best-effort: never throws for a Garmin or file problem.
 */
export async function syncGarminActivityFiles(
  userId: string,
  session: GarminSession,
  opts: { now?: Date } = {},
): Promise<GarminActivityFileCounts> {
  const now = (opts.now ?? new Date()).getTime();
  prune(now);
  const counts: GarminActivityFileCounts = {
    fetched: 0,
    attached: 0,
    unusable: 0,
  };
  if ((refusedUntil.get(userId) ?? 0) > now) return counts;

  const candidates = await prisma.workout.findMany({
    where: {
      userId,
      source: "GARMIN",
      externalId: { not: null },
      samples: { is: null },
      createdAt: { gte: new Date(now - CANDIDATE_WRITTEN_WITHIN_MS) },
      startedAt: { gte: new Date(now - CANDIDATE_STARTED_WITHIN_MS) },
    },
    orderBy: [{ startedAt: "desc" }, { id: "asc" }],
    take: GARMIN_ACTIVITY_FILES_PER_SYNC * 4,
    select: { externalId: true, startedAt: true },
  });
  const due = candidates
    .filter(
      (w) =>
        w.externalId !== null &&
        ACTIVITY_ID.test(w.externalId) &&
        !askedAt.has(`${userId}:${w.externalId}`),
    )
    .slice(0, GARMIN_ACTIVITY_FILES_PER_SYNC);
  if (due.length === 0) return counts;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { storeWorkoutRoutes: true, sourcePriorityJson: true },
  });
  const keepRoutes = user?.storeWorkoutRoutes === true;

  for (const workout of due) {
    const activityId = workout.externalId!;
    askedAt.set(`${userId}:${activityId}`, now);
    let file: Uint8Array | null;
    try {
      file = await session.getFile(
        "activity_file",
        `${GARMIN_PATHS.activityFile}/${activityId}`,
        FIT_UPLOAD_MAX_BYTES,
      );
    } catch (err) {
      if (isGarminRateLimit(err)) {
        counts.stopped = "rate_limited";
        break;
      }
      if (isGarminKeyRefusal(err)) {
        counts.stopped = "key_refused";
        break;
      }
      if (
        err instanceof GarminApiError &&
        err.httpStatus !== undefined &&
        err.httpStatus >= 400 &&
        err.httpStatus < 500 &&
        err.httpStatus !== 404
      ) {
        refusedUntil.set(userId, now + RETRY_AFTER_MS);
        counts.stopped = "refused";
        break;
      }
      // A 404 (no file kept for this activity) or a passing outage.
      counts.unusable += 1;
      continue;
    }
    if (file === null) {
      counts.unusable += 1;
      continue;
    }
    counts.fetched += 1;
    try {
      const attached = await attachGarminActivityFile({
        userId,
        activityId,
        workoutStartedAt: workout.startedAt,
        file,
        keepRoutes,
        sourcePriorityJson: user?.sourcePriorityJson ?? null,
      });
      if (attached) counts.attached += 1;
      else counts.unusable += 1;
    } catch (err) {
      counts.unusable += 1;
      if (!(err instanceof FitImportError)) {
        getEvent()?.addWarning(
          `garmin: activity file attach failed: ${err instanceof Error ? err.name : "error"}`,
        );
      }
    }
  }
  annotate({ meta: { "garmin.activity_files": { ...counts } } });
  return counts;
}
