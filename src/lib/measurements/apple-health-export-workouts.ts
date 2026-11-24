/**
 * The `<Workout>` side of the Apple Health `export.xml` import: the row a
 * workout becomes, its identity across exports (#1414), the totals read from
 * its attributes and from its `<WorkoutStatistics>` children, and the move of
 * a row still stored under the pre-#1414 key. The streaming parser in
 * `import-apple-health-export.ts` drives these per element.
 */
import { createHash } from "node:crypto";

import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import type { WorkoutRouteReference } from "@/lib/apple-health/route-import";
import { workoutSessionKey } from "@/lib/measurements/pick-canonical-workout-rows";
import {
  exportRowsOf,
  foldExportCopiesInto,
  healthKitRowOf,
  readAppleHealthSessionRows,
  type WorkoutSession,
} from "@/lib/workouts/export-healthkit-twins";
import {
  convertHkValue,
  hkDistanceToMetres,
} from "@/lib/measurements/hk-units";

/** Flush row written to the `Workout` table. */
export interface PreparedWorkout {
  userId: string;
  sportType: string;
  startedAt: Date;
  endedAt: Date;
  durationSec: number;
  totalEnergyKcal: number | null;
  totalDistanceM: number | null;
  avgHeartRate: number | null;
  minHeartRate: number | null;
  maxHeartRate: number | null;
  externalId: string;
  /**
   * The key this workout was stored under before #1414
   * (`hashSampleKey` over the raw attribute strings). A row still carrying
   * it takes the new key instead of gaining a twin.
   */
  legacyExternalId: string;
  externalSourceVersion: string | null;
  metadata: Prisma.JsonValue | null;
  /** The `<FileReference path>` of the workout's GPS track, when it has one. */
  routePath?: string;
  /** Totals from the workout's `<WorkoutStatistics>` children. */
  statistics: WorkoutStatisticsTotals;
  /**
   * The totals `fillFromWorkoutStatistics` took from the statistics rather
   * than the attributes. On a re-import they only fill a stored total that
   * is empty; they never replace one.
   */
  filledFromStatistics?: WorkoutTotalField[];
}

export type WorkoutTotalField =
  | "totalEnergyKcal"
  | "totalDistanceM"
  | "avgHeartRate"
  | "minHeartRate"
  | "maxHeartRate";

/**
 * What a workout's `<WorkoutStatistics>` children add up to. Current iOS
 * exports carry the totals there rather than as attributes on `<Workout>`;
 * they fill a field only where the attributes left it empty. Only the
 * workout's direct children count: a multisport workout repeats its
 * statistics per leg inside `<WorkoutActivity>`, and adding those as well
 * would count every leg twice (the parser skips them).
 */
interface WorkoutStatisticsTotals {
  energyKcal: number | null;
  distanceM: number | null;
  avgHeartRate: number | null;
  minHeartRate: number | null;
  maxHeartRate: number | null;
}

/**
 * The figures a `<Workout>` element states as attributes, in the canonical
 * units, with the heart rate and statistics left for its children to fill.
 */
export function exportWorkoutFigures(
  attrs: Record<string, string>,
): Pick<
  PreparedWorkout,
  | "totalEnergyKcal"
  | "totalDistanceM"
  | "avgHeartRate"
  | "minHeartRate"
  | "maxHeartRate"
  | "statistics"
> {
  const totalDistance = Number.parseFloat(attrs.totalDistance ?? "");
  const totalEnergy = Number.parseFloat(attrs.totalEnergyBurned ?? "");
  const distanceUnit = attrs.totalDistanceUnit ?? "";
  const energyUnit = attrs.totalEnergyBurnedUnit ?? "";
  return {
    totalEnergyKcal: Number.isFinite(totalEnergy)
      ? // issue #944 — the energy attribute carries the account's own
        // unit too: a Health app set to kilojoules writes `kJ` here, and
        // the column is kilocalories. Same shared conversion; an unknown
        // unit leaves the number alone.
        (convertHkValue(totalEnergy, energyUnit, "kcal") ?? totalEnergy)
      : null,
    // Apple ships the ACCOUNT's own length unit on HKWorkout.totalDistance
    // (km for a metric account, mi for an imperial one); metres is the
    // canonical DB unit. issue #944 — the same conversion the `<Record>`
    // path runs, so the two can never drift apart again.
    totalDistanceM: Number.isFinite(totalDistance)
      ? hkDistanceToMetres(totalDistance, distanceUnit)
      : null,
    avgHeartRate: null,
    minHeartRate: null,
    maxHeartRate: null,
    statistics: {
      energyKcal: null,
      distanceM: null,
      avgHeartRate: null,
      minHeartRate: null,
      maxHeartRate: null,
    },
  };
}

const HK_ACTIVE_ENERGY = "HKQuantityTypeIdentifierActiveEnergyBurned";
const HK_HEART_RATE = "HKQuantityTypeIdentifierHeartRate";
const HK_DISTANCE_PREFIX = "HKQuantityTypeIdentifierDistance";

function finiteAttr(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : null;
}

/** A heart rate in beats per minute, rounded; null when it is not one. */
function bpm(raw: string | undefined, unit: string): number | null {
  const value = finiteAttr(raw);
  if (value === null || value < 0) return null;
  // Apple writes `count/min`; any other unit is not read as a rate.
  if (unit !== "count/min") return null;
  return Math.round(value);
}

/**
 * Fold one `<WorkoutStatistics>` element into the workout's totals: the
 * active energy and every distance type as sums in the canonical units, the
 * heart rate's average, minimum and maximum. Other types are ignored.
 */
function addWorkoutStatistics(
  totals: WorkoutStatisticsTotals,
  attrs: Record<string, string>,
): void {
  const type = attrs.type ?? "";
  const unit = (attrs.unit ?? "").trim();
  if (type === HK_ACTIVE_ENERGY) {
    const sum = finiteAttr(attrs.sum);
    if (sum === null || sum < 0) return;
    const kcal = convertHkValue(sum, unit, "kcal");
    if (kcal === null) return;
    totals.energyKcal = (totals.energyKcal ?? 0) + kcal;
    return;
  }
  if (type.startsWith(HK_DISTANCE_PREFIX)) {
    const sum = finiteAttr(attrs.sum);
    if (sum === null || sum < 0) return;
    const metres = convertHkValue(sum, unit, "m");
    if (metres === null) return;
    totals.distanceM = (totals.distanceM ?? 0) + metres;
    return;
  }
  if (type === HK_HEART_RATE) {
    totals.avgHeartRate = bpm(attrs.average, unit) ?? totals.avgHeartRate;
    totals.minHeartRate = bpm(attrs.minimum, unit) ?? totals.minHeartRate;
    totals.maxHeartRate = bpm(attrs.maximum, unit) ?? totals.maxHeartRate;
  }
}

/**
 * The statistics fill each field the `<Workout>` attributes left empty, and
 * the workout notes which fields they filled.
 */
function fillFromWorkoutStatistics(workout: PreparedWorkout): void {
  const stats = workout.statistics;
  const filled: WorkoutTotalField[] = [];
  const fill = (field: WorkoutTotalField, value: number | null) => {
    if (workout[field] !== null || value === null) return;
    workout[field] = value;
    filled.push(field);
  };
  fill("totalEnergyKcal", stats.energyKcal);
  fill("totalDistanceM", stats.distanceM);
  fill("avgHeartRate", stats.avgHeartRate);
  fill("minHeartRate", stats.minHeartRate);
  fill("maxHeartRate", stats.maxHeartRate);
  workout.filledFromStatistics = filled;
}

const WORKOUT_TOTAL_FIELDS: readonly WorkoutTotalField[] = [
  "totalEnergyKcal",
  "totalDistanceM",
  "avgHeartRate",
  "minHeartRate",
  "maxHeartRate",
];

/**
 * What a re-import writes over a stored workout's totals. A total the export
 * does not state leaves the stored one. One taken from the statistics only
 * fills a stored total that is empty: a total stored earlier (from an older
 * export's attributes, or entered by hand) is not replaced by a sum.
 */
export function workoutTotalsUpdate(
  row: PreparedWorkout,
  stored: Record<WorkoutTotalField, number | null> | undefined,
): Partial<Record<WorkoutTotalField, number>> {
  const fromStatistics = new Set(row.filledFromStatistics ?? []);
  const out: Partial<Record<WorkoutTotalField, number>> = {};
  for (const field of WORKOUT_TOTAL_FIELDS) {
    const value = row[field];
    if (value === null) continue;
    if (fromStatistics.has(field) && (stored?.[field] ?? null) !== null) {
      continue;
    }
    out[field] = value;
  }
  return out;
}

/**
 * The identity of a workout read from an export (#1414): its activity type
 * and its start and end as UTC instants. The raw attribute strings it used to
 * hash are not stable across exports: the same workout comes back with its
 * dates written in another offset and its duration at another precision, and
 * each new spelling inserted it again. Migration 0513 moved the stored rows
 * onto this key with the same formula in SQL (`sha256` over
 * `activity|startMs|endMs`, the empty activity read as `Workout`); the two
 * must not drift apart.
 */
export function workoutExternalId(
  activityType: string,
  startedAt: Date,
  endedAt: Date,
): string {
  return (
    "workout:" +
    createHash("sha256")
      .update(
        `${activityType || "Workout"}|${startedAt.getTime()}|${endedAt.getTime()}`,
      )
      .digest("hex")
      .slice(0, 28)
  );
}

/**
 * A row stored under a workout's pre-#1414 key takes the new key, so the
 * batch insert that follows finds it and updates it instead of adding a twin. Migration
 * 0513 moved every row it could place; this catches a row it could not
 * (one stored without its activity type). Where a row already holds the
 * new key, the old one is left alone.
 */
export async function adoptLegacyWorkoutKeys(
  prisma: Pick<PrismaClient, "workout">,
  userId: string,
  chunk: readonly PreparedWorkout[],
): Promise<void> {
  const legacy = chunk
    .filter((row) => row.legacyExternalId !== row.externalId)
    .map((row) => row.legacyExternalId);
  if (legacy.length === 0) return;
  const held = await prisma.workout.findMany({
    where: {
      userId,
      source: "APPLE_HEALTH",
      externalId: { in: [...legacy, ...chunk.map((row) => row.externalId)] },
    },
    select: { externalId: true },
  });
  const keys = new Set(held.map((row) => row.externalId));
  for (const row of chunk) {
    if (!keys.has(row.legacyExternalId) || keys.has(row.externalId)) {
      continue;
    }
    await prisma.workout.update({
      where: {
        userId_source_externalId: {
          userId,
          source: "APPLE_HEALTH",
          externalId: row.legacyExternalId,
        },
      },
      data: { externalId: row.externalId },
    });
    keys.delete(row.legacyExternalId);
    keys.add(row.externalId);
  }
}

/**
 * Where the parser stands among a workout's children, and the workouts the
 * export has already stated.
 *
 * A multisport workout (iOS 16+) repeats its `<WorkoutStatistics>` per leg
 * inside `<WorkoutActivity>`; only the workout's direct children count, or
 * every leg would be added twice. A workout stated twice in one export (the
 * same activity, start and end, from the watch and from another app) is
 * admitted once: the first stands, the repeat neither inserts nor updates.
 */
export function exportWorkoutTracker() {
  let activityDepth = 0;
  const seen = new Set<string>();
  return {
    /**
     * An element opening inside the current workout. True when it was a
     * `<WorkoutActivity>` or a `<WorkoutStatistics>` (folded in when it is
     * the workout's own), so the parser has nothing left to do with it.
     */
    open(
      name: string,
      workout: PreparedWorkout,
      attrs: Record<string, string>,
    ): boolean {
      if (name === "WorkoutActivity") {
        activityDepth += 1;
        return true;
      }
      if (name !== "WorkoutStatistics") return false;
      if (activityDepth === 0) addWorkoutStatistics(workout.statistics, attrs);
      return true;
    },
    leaveActivity(): void {
      if (activityDepth > 0) activityDepth -= 1;
    },
    /**
     * At `</Workout>`: false for a repeat. Otherwise the statistics fill the
     * totals, the route is handed on, and the workout is to be written.
     */
    admit(
      workout: PreparedWorkout,
      onRoute: ((ref: WorkoutRouteReference) => void) | undefined,
    ): boolean {
      activityDepth = 0;
      if (seen.has(workout.externalId)) return false;
      seen.add(workout.externalId);
      fillFromWorkoutStatistics(workout);
      if (workout.routePath && onRoute) {
        onRoute({
          externalId: workout.externalId,
          path: workout.routePath,
          sportType: workout.sportType,
          startedAt: workout.startedAt,
          durationSec: workout.durationSec,
        });
      }
      return true;
    },
  };
}

/** The stored totals of the given export workouts, by key. */
export async function storedWorkoutTotals(
  prisma: Pick<PrismaClient, "workout">,
  userId: string,
  rows: readonly PreparedWorkout[],
): Promise<Map<string, Record<WorkoutTotalField, number | null>>> {
  const out = new Map<string, Record<WorkoutTotalField, number | null>>();
  if (rows.length === 0) return out;
  const held = await prisma.workout.findMany({
    where: {
      userId,
      source: "APPLE_HEALTH",
      externalId: { in: rows.map((row) => row.externalId) },
    },
    select: {
      externalId: true,
      totalEnergyKcal: true,
      totalDistanceM: true,
      avgHeartRate: true,
      minHeartRate: true,
      maxHeartRate: true,
    },
  });
  for (const row of held) if (row.externalId) out.set(row.externalId, row);
  return out;
}

/**
 * Hand every export workout whose session the iPhone app already stored to
 * the app's row (#1414): the export fills what that row leaves empty, any
 * export copy of the session stored earlier folds into it too
 * (`foldExportCopiesInto`), and nothing new is stored. Returns the workouts
 * left to store under their export key, and how many were merged.
 */
export async function foldIntoHealthKitRows(
  prisma: Pick<PrismaClient, "workout" | "$transaction">,
  userId: string,
  chunk: readonly PreparedWorkout[],
): Promise<{ rest: PreparedWorkout[]; merged: number; durationMs: number }> {
  const sessionOf = (row: PreparedWorkout): WorkoutSession => ({
    source: "APPLE_HEALTH",
    sportType: row.sportType,
    startedAt: row.startedAt,
    durationSec: row.durationSec,
  });
  const stored = await readAppleHealthSessionRows(
    prisma,
    userId,
    chunk.map(sessionOf),
  );
  const out = { rest: [] as PreparedWorkout[], merged: 0, durationMs: 0 };
  for (const row of chunk) {
    const key = workoutSessionKey(sessionOf(row)) ?? "";
    const group = stored.get(key);
    const kept = healthKitRowOf(group);
    if (!kept) {
      out.rest.push(row);
      continue;
    }
    const startedAt = Date.now();
    await prisma.$transaction((tx) =>
      foldExportCopiesInto(tx, userId, kept, exportRowsOf(group), [row]),
    );
    // The copies are gone and `kept` now holds what they gave it, so a
    // second export workout of this session fills only what is still empty.
    stored.set(key, [kept]);
    out.merged += 1;
    out.durationMs += Date.now() - startedAt;
  }
  return out;
}
