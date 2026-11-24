/**
 * The workout summaries, with both backup ends in one file. GPS routes and
 * per-sample series do not travel, and the file's manifest says so.
 *
 * A file written from v1.48.2 to v1.48.x may also carry
 * `appleHealthTombstones`, the ledger 0546 removed; the restore ignores it.
 */
import type {
  MeasurementSource,
  Prisma,
  PrismaClient,
} from "@/generated/prisma/client";
import { toJson } from "@/lib/db";
import type { RestoreContext } from "@/lib/export/restore-context";
import { workoutExternalId } from "@/lib/measurements/apple-health-export-workouts";
import { workoutSessionKey } from "@/lib/measurements/pick-canonical-workout-rows";
import {
  foldedWorkoutValues,
  isExportWorkout,
  isHealthKitWorkout,
} from "@/lib/workouts/export-healthkit-twins";

// ── Export ───────────────────────────────────────────────────────────────────

export interface WorkoutBackupEntry {
  /** Present in canonical DR payloads for manual workouts without externalId. */
  id?: string;
  createdAt?: string;
  updatedAt?: string;
  sportType: string;
  startedAt: string;
  endedAt: string;
  durationSec: number;
  totalEnergyKcal: number | null;
  totalDistanceM: number | null;
  avgHeartRate: number | null;
  maxHeartRate: number | null;
  minHeartRate: number | null;
  stepCount: number | null;
  elevationM: number | null;
  pauseDurationSec: number | null;
  source: string;
  externalId: string | null;
  /** Canonical DR only; portable workout summaries keep their existing shape. */
  metadata?: Prisma.JsonValue;
  /** Canonical DR only, beside `metadata`: the source's own version marker. */
  externalSourceVersion?: string | null;
}

/** The workout slice of the records section. */
export async function buildWorkoutsBackupSlice(
  prisma: Pick<PrismaClient, "workout">,
  userId: string,
  disasterRecovery: boolean,
): Promise<{ workouts: WorkoutBackupEntry[] }> {
  const workoutRows = await prisma.workout.findMany({
    where: { userId },
    orderBy: [{ startedAt: "desc" }, { id: "asc" }],
  });

  const workouts: WorkoutBackupEntry[] = workoutRows.map((w) => ({
    ...(disasterRecovery
      ? {
          id: w.id,
          createdAt: w.createdAt.toISOString(),
          updatedAt: w.updatedAt.toISOString(),
          ...(w.metadata == null ? {} : { metadata: w.metadata }),
          externalSourceVersion: w.externalSourceVersion,
        }
      : {}),
    sportType: w.sportType,
    startedAt: w.startedAt.toISOString(),
    endedAt: w.endedAt.toISOString(),
    durationSec: w.durationSec,
    totalEnergyKcal: w.totalEnergyKcal,
    totalDistanceM: w.totalDistanceM,
    avgHeartRate: w.avgHeartRate,
    maxHeartRate: w.maxHeartRate,
    minHeartRate: w.minHeartRate,
    stepCount: w.stepCount,
    elevationM: w.elevationM,
    pauseDurationSec: w.pauseDurationSec,
    source: w.source,
    externalId: w.externalId,
  }));
  return { workouts };
}

// ── Restore ──────────────────────────────────────────────────────────────────

export async function clearWorkouts(ctx: RestoreContext): Promise<void> {
  const workouts = await ctx.tx.workout.deleteMany({
    where: { userId: ctx.ownerId },
  });
  ctx.cleared.workouts = workouts.count;
}

type RestorableWorkout = RestoreContext["payload"]["workouts"][number];

const COPY_FILLED_TOTALS = [
  "totalEnergyKcal",
  "totalDistanceM",
  "avgHeartRate",
  "minHeartRate",
  "maxHeartRate",
] as const;

/**
 * The export workouts of a file written before #1414, collapsed the way
 * migration 0513 collapses stored ones. Such a file can hold one workout
 * several times under the old per-spelling keys, and the migration does not
 * run again after a restore, so the copies would come back. Every Apple
 * Health export workout that carries its activity type in `metadata` takes
 * the key the importer computes now (`workoutExternalId`); of each group the
 * oldest entry (by `createdAt`, then `id`) is kept, an empty total on it is
 * filled from the oldest copy that states one, and the copies are left out.
 * Every old key of a group maps to the new one, so a personal record that
 * names a copy follows the kept row (`workoutKeyByLegacyKey`).
 */
function collapseExportWorkoutCopies(workouts: readonly RestorableWorkout[]): {
  workouts: RestorableWorkout[];
  keyByLegacyKey: Map<string, string>;
} {
  const keyByLegacyKey = new Map<string, string>();
  const groups = new Map<string, RestorableWorkout[]>();
  const order: Array<RestorableWorkout | string> = [];
  for (const workout of workouts) {
    const key = exportWorkoutKey(workout);
    if (key === null) {
      order.push(workout);
      continue;
    }
    keyByLegacyKey.set(workout.externalId as string, key);
    const group = groups.get(key);
    if (group) group.push(workout);
    else {
      groups.set(key, [workout]);
      order.push(key);
    }
  }
  const out: RestorableWorkout[] = [];
  for (const item of order) {
    if (typeof item !== "string") {
      out.push(item);
      continue;
    }
    const group = [...(groups.get(item) ?? [])].sort(oldestFirst);
    const kept: RestorableWorkout = { ...group[0], externalId: item };
    for (const field of COPY_FILLED_TOTALS) {
      if (kept[field] !== null && kept[field] !== undefined) continue;
      const from = group.find(
        (copy) => copy[field] !== null && copy[field] !== undefined,
      );
      if (from) kept[field] = from[field];
    }
    out.push(kept);
  }
  return { workouts: out, keyByLegacyKey };
}

/** The #1414 key of an Apple Health export workout, or null for any other. */
function exportWorkoutKey(workout: RestorableWorkout): string | null {
  const externalId = workout.externalId;
  if (workout.source !== "APPLE_HEALTH" || !externalId) return null;
  if (!externalId.startsWith("sample:") && !externalId.startsWith("workout:")) {
    return null;
  }
  const metadata = workout.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const activityType = (metadata as Record<string, unknown>).activityType;
  if (typeof activityType !== "string") return null;
  const startedAt = new Date(workout.startedAt);
  const endedAt = new Date(workout.endedAt);
  if (Number.isNaN(startedAt.getTime()) || Number.isNaN(endedAt.getTime())) {
    return null;
  }
  return workoutExternalId(activityType, startedAt, endedAt);
}

/**
 * The export workouts of a file written before #1414 was finished, folded
 * into the HealthKit workout of their session the way the importer and
 * migration 0562 fold stored ones: an export entry whose session
 * (`workoutSessionKey`) has a HealthKit entry is left out, and the oldest
 * HealthKit entry of the session fills each column it leaves empty from the
 * oldest export entry that states it (`foldedWorkoutValues`). A personal
 * record that names a left-out entry, under any of its keys, follows the
 * HealthKit one (`keyByLegacyKey`, updated in place).
 */
function foldExportEntriesIntoHealthKit(
  workouts: readonly RestorableWorkout[],
  keyByLegacyKey: Map<string, string>,
): RestorableWorkout[] {
  const sessionKey = (workout: RestorableWorkout) => {
    const startedAt = new Date(workout.startedAt);
    if (Number.isNaN(startedAt.getTime())) return null;
    return workoutSessionKey({
      source: workout.source as MeasurementSource,
      sportType: workout.sportType,
      startedAt,
      durationSec: workout.durationSec,
    });
  };
  const healthKit = new Map<string, RestorableWorkout>();
  const exports = new Map<string, RestorableWorkout[]>();
  for (const workout of [...workouts].sort(oldestFirst)) {
    const key = sessionKey(workout);
    if (key === null) continue;
    if (isHealthKitWorkout(workout)) {
      if (!healthKit.has(key)) healthKit.set(key, workout);
    } else if (isExportWorkout(workout)) {
      const group = exports.get(key);
      if (group) group.push(workout);
      else exports.set(key, [workout]);
    }
  }
  const replaced = new Map<RestorableWorkout, RestorableWorkout>();
  const dropped = new Set<RestorableWorkout>();
  for (const [key, copies] of exports) {
    const kept = healthKit.get(key);
    if (!kept) continue;
    replaced.set(kept, { ...kept, ...foldedWorkoutValues(kept, copies) });
    const copyKeys = new Set<string>();
    for (const copy of copies) {
      dropped.add(copy);
      if (copy.externalId) copyKeys.add(copy.externalId);
    }
    for (const [legacy, current] of keyByLegacyKey) {
      if (copyKeys.has(current)) keyByLegacyKey.set(legacy, kept.externalId!);
    }
    for (const copyKey of copyKeys) {
      keyByLegacyKey.set(copyKey, kept.externalId!);
    }
  }
  if (dropped.size === 0) return [...workouts];
  return workouts
    .filter((workout) => !dropped.has(workout))
    .map((workout) => replaced.get(workout) ?? workout);
}

function oldestFirst(a: RestorableWorkout, b: RestorableWorkout): number {
  const byCreated = (a.createdAt ?? "").localeCompare(b.createdAt ?? "");
  if (byCreated !== 0) return byCreated;
  return (a.id ?? "").localeCompare(b.id ?? "");
}

export async function restoreWorkouts(ctx: RestoreContext): Promise<void> {
  const { tx, ownerId, payload } = ctx;
  if (payload.workouts.length === 0) return;
  const collapsed = collapseExportWorkoutCopies(payload.workouts);
  const { keyByLegacyKey } = collapsed;
  const workouts = foldExportEntriesIntoHealthKit(
    collapsed.workouts,
    keyByLegacyKey,
  );
  for (const [legacy, key] of keyByLegacyKey) {
    ctx.links.workoutKeyByLegacyKey.set(legacy, key);
  }
  await tx.workout.createMany({
    data: workouts.map((workout) => ({
      ...(workout.id ? { id: workout.id } : {}),
      userId: ownerId,
      sportType: workout.sportType,
      startedAt: new Date(workout.startedAt),
      endedAt: new Date(workout.endedAt),
      durationSec: workout.durationSec,
      totalEnergyKcal: workout.totalEnergyKcal ?? null,
      totalDistanceM: workout.totalDistanceM ?? null,
      avgHeartRate: workout.avgHeartRate ?? null,
      maxHeartRate: workout.maxHeartRate ?? null,
      minHeartRate: workout.minHeartRate ?? null,
      stepCount: workout.stepCount ?? null,
      elevationM: workout.elevationM ?? null,
      pauseDurationSec: workout.pauseDurationSec ?? null,
      source: workout.source as never,
      externalId: workout.externalId ?? null,
      externalSourceVersion: workout.externalSourceVersion ?? null,
      ...(workout.metadata == null
        ? {}
        : { metadata: toJson(workout.metadata) }),
      ...(workout.createdAt ? { createdAt: new Date(workout.createdAt) } : {}),
      ...(workout.updatedAt ? { updatedAt: new Date(workout.updatedAt) } : {}),
    })),
  });
}
