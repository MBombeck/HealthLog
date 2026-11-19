/**
 * The `<Workout>` side of the Apple Health `export.xml` import: the row a
 * workout becomes, its identity across exports (#1414), the totals read from
 * its attributes and from its `<WorkoutStatistics>` children, and the move of
 * a row still stored under the pre-#1414 key. The streaming parser in
 * `import-apple-health-export.ts` drives these per element.
 */
import { createHash } from "node:crypto";

import type { Prisma, PrismaClient } from "@/generated/prisma/client";
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
}

/**
 * What a workout's `<WorkoutStatistics>` children add up to. Current iOS
 * exports carry the totals there rather than as attributes on `<Workout>`;
 * they fill a field only where the attributes left it empty.
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
export function addWorkoutStatistics(
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

/** The statistics fill each field the `<Workout>` attributes left empty. */
export function fillFromWorkoutStatistics(workout: PreparedWorkout): void {
  const stats = workout.statistics;
  workout.totalEnergyKcal ??= stats.energyKcal;
  workout.totalDistanceM ??= stats.distanceM;
  workout.avgHeartRate ??= stats.avgHeartRate;
  workout.minHeartRate ??= stats.minHeartRate;
  workout.maxHeartRate ??= stats.maxHeartRate;
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
