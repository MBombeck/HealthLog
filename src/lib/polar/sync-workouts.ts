/**
 * v1.32.15 — Polar AccessLink exercise (workout) sync.
 *
 * Pulls the user's exercises from the stateless `GET /v3/exercises` list (last
 * 30 days of uploads, no transaction / no commit / no userId in the path) and
 * upserts each into the `Workout` table as `source = POLAR`, keyed on
 * `(userId, source, externalId)` so a re-fetch / Polar-side re-analysis
 * overwrites in place. Polar exercises are WORKOUT rows, not `Measurement`
 * rows, so this file is deliberately SEPARATE from the vitals sync
 * (`./sync.ts`) — isolation for a sensitive cohort, mirroring WHOOP's split
 * `sync.ts` / `sync-workout.ts`.
 *
 * Cross-source dedup is NOT done here: a Polar run and the same run via Apple
 * Health remain two distinct `Workout` rows (different `source`); the read-time
 * `pickCanonicalWorkoutRows` picker collapses the cross-source twin via the
 * user's source-priority ladder. One engine, no parallel path.
 *
 * Idempotency: every tick re-reads the whole 30-day window; the unique index
 * makes a re-ingest a no-op-shaped overwrite. There is no commit / acknowledge
 * step to fail (the deprecated transaction model had one), so ingest is the
 * only write and it is idempotent — no cursor, no backfill queue (the API caps
 * history at 30 days, so first-connect backfill IS the first regular tick).
 *
 * Ledger: workouts and vitals share the single `polar` integration ledger, each
 * under its own leg. This leg records its own failure (and rethrows so the
 * cohort handler can attribute it) and its own success. The success used to be
 * left to the vitals leg, but a leg-scoped success clears only its own leg, so
 * a workouts failure stayed on the row for good once recorded: every later
 * vitals success saw the workouts leg still failing and kept the connection in
 * error, however healthy the exercises read had become.
 */
import { prisma } from "@/lib/db";
import { emitInsertedWorkoutArrival } from "@/lib/arrivals/workout-emit";
import { invalidateUserMeasurements } from "@/lib/cache/invalidate";
import { annotate, getEvent } from "@/lib/logging/context";
import {
  markSyncFailureRecorded,
  recordSyncFailure,
  recordSyncSuccess,
  toFailureKind,
} from "@/lib/integrations/status";
import { fetchExercises } from "./client";
import { mapExercise, type PolarWorkoutRow } from "./map";
import { getPolarConnection } from "./credentials";
import {
  PolarApiError,
  classifyPolarError,
  isPolarCollectionRefusal,
} from "./response-classifier";

const POLAR_LEG_WORKOUTS = "workouts";

async function recordPolarWorkoutFailure(
  userId: string,
  err: unknown,
): Promise<void> {
  await recordSyncFailure({
    userId,
    integration: "polar",
    // The workouts leg rides the same hourly tick as vitals but owns its own
    // errors: the vitals success stamp must not clear a failure from here.
    leg: POLAR_LEG_WORKOUTS,
    // Same classification the vitals leg uses (`classifyPolarFailure` in
    // `./sync`); resolved directly off the shared classifier so this leg does
    // not have to import the heavier vitals-sync module.
    kind: toFailureKind(classifyPolarError(err)),
    message: err instanceof Error ? err.message : String(err),
    errorCode:
      err instanceof PolarApiError && err.httpStatus != null
        ? String(err.httpStatus)
        : undefined,
  });
}

/**
 * Sync one user's Polar exercises into `Workout`. Returns the count of rows
 * written. A user with no Polar connection is a clean no-op (returns 0, touches
 * no status row).
 *
 * A 403 on the exercises read is a refusal when the vitals leg proved the token
 * in the same run (`tokenProven`): the account does not share exercises, which
 * no reconnect changes, so the leg reads nothing and stays healthy. Without
 * that proof the 403 is classified `reauth_required` as before, recorded, and
 * rethrown so the composite cohort pass isolates this user.
 */
export async function syncUserPolarWorkouts(
  userId: string,
  opts: { tokenProven?: boolean } = {},
): Promise<number> {
  const conn = await getPolarConnection(userId);
  if (!conn) return 0;

  let rows: PolarWorkoutRow[];
  try {
    const exercises = await fetchExercises(conn.accessToken);
    rows = [];
    for (const ex of exercises) {
      const row = mapExercise(ex);
      // Skip an unmappable exercise (no id / unparseable start); never throw
      // per-row — one bad record must not fail the whole leg.
      if (row) rows.push(row);
    }
  } catch (err) {
    if (opts.tokenProven && isPolarCollectionRefusal(err)) {
      annotate({ meta: { polar_collections_refused: [POLAR_LEG_WORKOUTS] } });
      await recordSyncSuccess(userId, "polar", { leg: POLAR_LEG_WORKOUTS });
      return 0;
    }
    await recordPolarWorkoutFailure(userId, err);
    throw markSyncFailureRecorded(err);
  }

  let imported: number;
  try {
    imported = await upsertPolarWorkouts(userId, rows);
  } catch (err) {
    await recordPolarWorkoutFailure(userId, err);
    throw markSyncFailureRecorded(err);
  }

  // Sweep the workouts cache (and mark the analytics cells stale — workouts
  // feed achievements + analytics) so the upserted rows reach the cached
  // readers, matching the `/api/workouts/batch` and Google Health writers.
  if (imported > 0) {
    invalidateUserMeasurements(userId);
  }

  await recordSyncSuccess(userId, "polar", { leg: POLAR_LEG_WORKOUTS });
  return imported;
}

/**
 * Upsert a batch of mapped Polar exercises into `Workout`, keyed on
 * `(userId, source = POLAR, externalId)` so a re-fetch overwrites in place. A
 * line-for-line mirror of `upsertStravaWorkouts`: `createManyAndReturn` +
 * `skipDuplicates`, update-in-place on conflict, arrival emit on fresh inserts
 * only. Failed rows are logged while the rest of the batch is attempted, then
 * the FIRST error is rethrown so the caller cannot treat a partially persisted
 * batch as a clean pass.
 */
export async function upsertPolarWorkouts(
  userId: string,
  rows: readonly PolarWorkoutRow[],
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
          source: "POLAR",
          externalId: r.externalId,
          ...data,
        },
        skipDuplicates: true,
        select: { id: true, startedAt: true },
      });
      if (inserted) {
        void emitInsertedWorkoutArrival(userId, inserted, "polar").catch(
          () => {},
        );
      } else {
        await prisma.workout.update({
          where: {
            userId_source_externalId: {
              userId,
              source: "POLAR",
              externalId: r.externalId,
            },
          },
          data,
        });
      }
      imported += 1;
    } catch (err) {
      getEvent()?.addWarning(`polar: failed to upsert workout: ${err}`);
      if (!hadError) {
        firstError = err;
        hadError = true;
      }
    }
  }
  if (hadError) throw firstError;

  annotate({
    action: { name: "polar.workout.ingest", details: { imported } },
  });
  return imported;
}
