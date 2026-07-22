import { getAgeFromDateOfBirth } from "@/lib/analytics/pulse-targets";
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import {
  buildWorkoutHrSeries,
  type WorkoutHrSeries,
  type WorkoutHrSeriesInput,
} from "@/lib/workouts/hr-series";
import {
  buildSportContext,
  type WorkoutSportContext,
} from "@/lib/workouts/sport-context";
import {
  computeZones,
  hrMaxFromAge,
  parseWhoopZoneDurations,
  type ComputeZonesInput,
  type WorkoutZones,
} from "@/lib/workouts/zones";

import {
  buildWorkoutEvidence,
  type WorkoutEvidenceInput,
} from "./workout-evidence";

interface WorkoutEvidenceRow {
  sportType: string;
  source: string;
  startedAt: Date;
  endedAt: Date;
  durationSec: number;
  totalEnergyKcal: number | null;
  totalDistanceM: number | null;
  avgHeartRate: number | null;
  maxHeartRate: number | null;
  minHeartRate: number | null;
  stepCount: number | null;
  elevationM: number | null;
  pauseDurationSec: number | null;
  metadata: unknown;
  samples: { samples: unknown } | null;
}

interface WorkoutEvidenceProfile {
  sourcePriorityJson: unknown;
  dateOfBirth: Date | null;
  timezone: string | null;
}

interface WorkoutEvidenceDependencies {
  findWorkout: (
    userId: string,
    workoutId: string,
  ) => Promise<WorkoutEvidenceRow | null>;
  findProfile: (userId: string) => Promise<WorkoutEvidenceProfile | null>;
  buildHrSeries: (
    input: WorkoutHrSeriesInput,
  ) => Promise<WorkoutHrSeries | null>;
  computeZones: (input: ComputeZonesInput) => WorkoutZones | null;
  hrMaxFromAge: (age: number | null) => number | null;
  getAgeFromDateOfBirth: (dateOfBirth: Date | null) => number | null;
  parseWhoopZoneDurations: (metadata: unknown) => number[] | null;
  buildSportContext: (
    userId: string,
    sportType: string,
    sourcePriorityJson: unknown,
    excludeWorkoutId?: string,
  ) => Promise<WorkoutSportContext | null>;
  buildEvidence: (input: WorkoutEvidenceInput) => Record<string, unknown>;
  onSkipped: () => void;
}

export function createWorkoutEvidenceBuilder(
  dependencies: WorkoutEvidenceDependencies,
): (
  userId: string,
  workoutId: string,
) => Promise<Record<string, unknown> | null> {
  return async (userId, workoutId) => {
    try {
      const row = await dependencies.findWorkout(userId, workoutId);
      if (!row) return null;

      const profile = await dependencies.findProfile(userId);
      const hrSeries = await dependencies.buildHrSeries({
        userId,
        startedAt: row.startedAt,
        endedAt: row.endedAt,
        durationSec: row.durationSec,
        storedSamples: row.samples?.samples ?? null,
      });
      const zones = dependencies.computeZones({
        hrMax: dependencies.hrMaxFromAge(
          dependencies.getAgeFromDateOfBirth(profile?.dateOfBirth ?? null),
        ),
        series: hrSeries?.points ?? [],
        bucketSec: hrSeries?.bucketSec ?? 0,
        whoopZoneDurations: dependencies.parseWhoopZoneDurations(row.metadata),
      });
      const sportContext = await dependencies.buildSportContext(
        userId,
        row.sportType,
        profile?.sourcePriorityJson ?? null,
        workoutId,
      );

      return dependencies.buildEvidence({
        sportType: row.sportType,
        source: row.source,
        startedAt: row.startedAt,
        timezone: profile?.timezone ?? "Europe/Berlin",
        durationSec: row.durationSec,
        totalEnergyKcal: row.totalEnergyKcal,
        totalDistanceM: row.totalDistanceM,
        avgHeartRate: row.avgHeartRate,
        maxHeartRate: row.maxHeartRate,
        minHeartRate: row.minHeartRate,
        stepCount: row.stepCount,
        elevationM: row.elevationM,
        pauseDurationSec: row.pauseDurationSec,
        zones,
        hrPoints: hrSeries?.points ?? [],
        sportContext,
      });
    } catch {
      dependencies.onSkipped();
      return null;
    }
  };
}

export const buildWorkoutEvidenceSection = createWorkoutEvidenceBuilder({
  findWorkout: async (userId, workoutId) =>
    prisma.workout.findFirst({
      where: { id: workoutId, userId },
      select: {
        sportType: true,
        source: true,
        startedAt: true,
        endedAt: true,
        durationSec: true,
        totalEnergyKcal: true,
        totalDistanceM: true,
        avgHeartRate: true,
        maxHeartRate: true,
        minHeartRate: true,
        stepCount: true,
        elevationM: true,
        pauseDurationSec: true,
        metadata: true,
        samples: { select: { samples: true } },
      },
    }),
  findProfile: async (userId) =>
    prisma.user.findUnique({
      where: { id: userId },
      select: {
        sourcePriorityJson: true,
        dateOfBirth: true,
        timezone: true,
      },
    }),
  buildHrSeries: buildWorkoutHrSeries,
  computeZones,
  hrMaxFromAge,
  getAgeFromDateOfBirth,
  parseWhoopZoneDurations,
  buildSportContext,
  buildEvidence: buildWorkoutEvidence,
  onSkipped: () => {
    annotate({
      action: { name: "coach.workout.evidence_skipped" },
      meta: { reason: "read_or_guard_failed" },
    });
  },
});
