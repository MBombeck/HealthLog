/**
 * One Apple Health workout, one row: the export copy of a session folds into
 * the row the iPhone app wrote for it (#1414).
 *
 * The app keys a workout on its HealthKit UUID. An `export.xml` carries no
 * UUID, so the export importer keys the same workout on its activity type and
 * its start and end (`workoutExternalId`, `workout:…`; `sample:…` before
 * #1414), and both rows were stored. The reads already counted the pair once
 * (`workoutSessionKey` in the canonical pick); since this module the writes
 * keep one row as well:
 *
 *   - an export workout whose session the app already stored fills what that
 *     row leaves empty and is not stored itself (the export importer);
 *   - a HealthKit workout whose session an export already stored takes the
 *     export row's data and the export row goes (the workout batch route);
 *   - a backup written before this folds the same way on restore
 *     (`workouts-backup.ts`), and migration 0562 folded the pairs already
 *     stored.
 *
 * "The same session" is `workoutSessionKey`, the rule the reads apply, and
 * nothing else. The HealthKit UUID stays the identity, because the phone
 * reports a deletion by that UUID. What a fold keeps: every column of the
 * HealthKit row it states; a column it leaves empty from the oldest copy that
 * states it (`FOLDED_WORKOUT_COLUMNS`); a GPS track, a heart-rate series and
 * a workout insight from the oldest copy that has one when the HealthKit row
 * has none; personal records that named a copy name the HealthKit row. The
 * export's `metadata` (its activity type, source name and units) is
 * provenance of the copy and nothing reads it, so it goes with the copy.
 */
import type {
  MeasurementSource,
  Prisma,
  PrismaClient,
} from "@/generated/prisma/client";
import { workoutSessionKey } from "@/lib/measurements/pick-canonical-workout-rows";

/** Whether an Apple Health workout key is one the export importer wrote. */
export function isAppleHealthExportKey(
  externalId: string | null | undefined,
): boolean {
  return (
    typeof externalId === "string" &&
    (externalId.startsWith("workout:") || externalId.startsWith("sample:"))
  );
}

/** A workout the iPhone app wrote: Apple Health, keyed on a HealthKit UUID. */
export function isHealthKitWorkout(row: {
  source: string;
  externalId?: string | null;
}): boolean {
  return (
    row.source === "APPLE_HEALTH" &&
    typeof row.externalId === "string" &&
    row.externalId.length > 0 &&
    !isAppleHealthExportKey(row.externalId)
  );
}

/** A workout an Apple Health export wrote. */
export function isExportWorkout(row: {
  source: string;
  externalId?: string | null;
}): boolean {
  return (
    row.source === "APPLE_HEALTH" && isAppleHealthExportKey(row.externalId)
  );
}

/** The columns the kept row fills from a copy where it states nothing. */
export const FOLDED_WORKOUT_COLUMNS = [
  "totalEnergyKcal",
  "totalDistanceM",
  "avgHeartRate",
  "minHeartRate",
  "maxHeartRate",
  "stepCount",
  "elevationM",
  "pauseDurationSec",
  "externalSourceVersion",
] as const;

export type FoldedWorkoutColumn = (typeof FOLDED_WORKOUT_COLUMNS)[number];

export type FoldedWorkoutValues = {
  totalEnergyKcal?: number | null;
  totalDistanceM?: number | null;
  avgHeartRate?: number | null;
  minHeartRate?: number | null;
  maxHeartRate?: number | null;
  stepCount?: number | null;
  elevationM?: number | null;
  pauseDurationSec?: number | null;
  externalSourceVersion?: string | null;
};

/**
 * What the kept row takes from its copies, oldest copy first: each folded
 * column it leaves empty, from the first copy that states it. Only the
 * columns that change. Pure; the importer, the batch route, the restore and
 * (in SQL) migration 0562 apply the same rule.
 */
export function foldedWorkoutValues(
  kept: FoldedWorkoutValues,
  copies: readonly FoldedWorkoutValues[],
): FoldedWorkoutValues {
  const out: Record<string, number | string> = {};
  for (const column of FOLDED_WORKOUT_COLUMNS) {
    if (kept[column] !== null && kept[column] !== undefined) continue;
    for (const copy of copies) {
      const value = copy[column];
      if (value !== null && value !== undefined) {
        out[column] = value;
        break;
      }
    }
  }
  return out as FoldedWorkoutValues;
}

/** The session a write is about, in the shape `workoutSessionKey` reads. */
export interface WorkoutSession {
  source: MeasurementSource;
  sportType: string;
  startedAt: Date;
  durationSec: number;
}

const STORED_SESSION_SELECT = {
  id: true,
  source: true,
  externalId: true,
  sportType: true,
  startedAt: true,
  durationSec: true,
  createdAt: true,
  totalEnergyKcal: true,
  totalDistanceM: true,
  avgHeartRate: true,
  minHeartRate: true,
  maxHeartRate: true,
  stepCount: true,
  elevationM: true,
  pauseDurationSec: true,
  externalSourceVersion: true,
  route: { select: { id: true } },
  samples: { select: { id: true } },
  insight: { select: { id: true } },
} as const satisfies Prisma.WorkoutSelect;

export type StoredSessionRow = Prisma.WorkoutGetPayload<{
  select: typeof STORED_SESSION_SELECT;
}>;

/** How many starts one probe names at most. */
const PROBE_CHUNK = 500;

type WorkoutReader = Pick<PrismaClient, "workout">;

/**
 * The stored Apple Health workouts that are the same session as one of
 * `sessions`, grouped by `workoutSessionKey`, each group oldest first. The
 * query narrows by start (the `(user_id, started_at)` index); the key decides.
 */
export async function readAppleHealthSessionRows(
  db: WorkoutReader,
  userId: string,
  sessions: readonly WorkoutSession[],
): Promise<Map<string, StoredSessionRow[]>> {
  const wanted = new Set<string>();
  const starts = new Map<number, Date>();
  for (const session of sessions) {
    if (session.source !== "APPLE_HEALTH") continue;
    const key = workoutSessionKey(session);
    if (key === null) continue;
    wanted.add(key);
    starts.set(session.startedAt.getTime(), session.startedAt);
  }
  const out = new Map<string, StoredSessionRow[]>();
  const all = [...starts.values()];
  for (let at = 0; at < all.length; at += PROBE_CHUNK) {
    const rows = await db.workout.findMany({
      where: {
        userId,
        source: "APPLE_HEALTH",
        startedAt: { in: all.slice(at, at + PROBE_CHUNK) },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: STORED_SESSION_SELECT,
    });
    for (const row of rows) {
      const key = workoutSessionKey(row);
      if (key === null || !wanted.has(key)) continue;
      const group = out.get(key);
      if (group) group.push(row);
      else out.set(key, [row]);
    }
  }
  return out;
}

/** The oldest HealthKit row of a session group, the one a fold keeps. */
export function healthKitRowOf(
  group: readonly StoredSessionRow[] | undefined,
): StoredSessionRow | null {
  return group?.find((row) => isHealthKitWorkout(row)) ?? null;
}

/** The export rows of a session group, oldest first. */
export function exportRowsOf(
  group: readonly StoredSessionRow[] | undefined,
): StoredSessionRow[] {
  return (group ?? []).filter((row) => isExportWorkout(row));
}

type FoldClient = Pick<
  Prisma.TransactionClient,
  | "workout"
  | "workoutRoute"
  | "workoutSamples"
  | "workoutInsight"
  | "personalRecord"
>;

/**
 * Fold export copies into the HealthKit row of their session. `incoming` is
 * an export workout being imported that is not stored (and will not be): its
 * values fill after the stored copies'. Runs inside the caller's
 * transaction. `kept` is updated in place to what it now holds, so a caller
 * folding a second workout into it sees the first one's fill. Returns whether
 * the HealthKit row or its children changed.
 */
export async function foldExportCopiesInto(
  tx: FoldClient,
  userId: string,
  kept: StoredSessionRow,
  copies: readonly StoredSessionRow[],
  incoming: readonly FoldedWorkoutValues[] = [],
): Promise<boolean> {
  const folded = copies.filter((copy) => copy.id !== kept.id);
  const values = foldedWorkoutValues(kept, [...folded, ...incoming]);
  const changesValues = Object.keys(values).length > 0;
  if (folded.length === 0) {
    if (changesValues) {
      await tx.workout.update({ where: { id: kept.id }, data: values });
      Object.assign(kept, values);
    }
    return changesValues;
  }

  // A child the kept row lacks, from the oldest copy that has one. Moved
  // before the copies go, or the delete's cascade would take it.
  const routeFrom = kept.route ? null : folded.find((c) => c.route);
  if (routeFrom) {
    await tx.workoutRoute.update({
      where: { workoutId: routeFrom.id },
      data: { workoutId: kept.id },
    });
    kept.route = routeFrom.route;
  }
  const samplesFrom = kept.samples ? null : folded.find((c) => c.samples);
  if (samplesFrom) {
    await tx.workoutSamples.update({
      where: { workoutId: samplesFrom.id },
      data: { workoutId: kept.id },
    });
    kept.samples = samplesFrom.samples;
  }
  const insightFrom = kept.insight ? null : folded.find((c) => c.insight);
  if (insightFrom) {
    await tx.workoutInsight.update({
      where: { workoutId: insightFrom.id },
      data: { workoutId: kept.id },
    });
    kept.insight = insightFrom.insight;
  }

  if (changesValues) {
    await tx.workout.update({ where: { id: kept.id }, data: values });
    Object.assign(kept, values);
  }

  // A personal record names its workout by key; it follows the kept row.
  const keys = folded
    .map((copy) => copy.externalId)
    .filter((key): key is string => key !== null);
  if (keys.length > 0 && kept.externalId) {
    await tx.personalRecord.updateMany({
      where: { userId, source: "APPLE_HEALTH", externalId: { in: keys } },
      data: { externalId: kept.externalId },
    });
  }

  await tx.workout.deleteMany({
    where: { userId, id: { in: folded.map((copy) => copy.id) } },
  });
  return true;
}
