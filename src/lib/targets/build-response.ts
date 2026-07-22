/**
 * `GET /api/insights/targets` response builder.
 *
 * Owns the bounded repository fan-out and public response composition. Pure
 * section builders live beside this module so timezone, classification, and
 * ordering rules can be tested without the route or database shell. The route
 * remains auth → `cachedSwr(buildTargetsResponse)` → `apiSuccess`.
 *
 * Every per-day bucket key resolves against the user's display timezone
 * (`userDayKey`) so streaks, "last met goal", and the consistency strip
 * are read in the user's own calendar.
 */
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { SCHEDULE_COMPLIANCE_SELECT } from "@/lib/analytics/compliance";
import { DEFAULT_TIMEZONE } from "@/lib/tz/resolver";
import pLimit from "p-limit";
import type { MeasurementType } from "@/generated/prisma/client";
import type { ThresholdOverridesJson } from "@/lib/analytics/effective-range";
import { resolveGlucoseUnit } from "@/lib/glucose";
import {
  ensureUserMoodRollupsFresh,
  readMoodDayRollups,
} from "@/lib/rollups/mood-rollups";
import { buildGlucoseTargets } from "./glucose-builder";
import { buildMedicationTarget } from "./medication-builder";
import { buildMoodTargets } from "./mood-builder";
import { buildSleepTarget } from "./sleep-builder";
import { buildTargetPageSummary } from "./summary-builder";
import { buildVitalTargets } from "./vitals-builder";
import type { TargetItem, TargetMoodEntry, TargetValueByType } from "./types";

import type { User } from "@/generated/prisma/client";

function getAge(dateOfBirth: Date): number {
  const today = new Date();
  let age = today.getFullYear() - dateOfBirth.getFullYear();
  const monthDiff = today.getMonth() - dateOfBirth.getMonth();
  if (
    monthDiff < 0 ||
    (monthDiff === 0 && today.getDate() < dateOfBirth.getDate())
  ) {
    age--;
  }
  return age;
}

/**
 * The authenticated-user shape the builder reads directly. The profile
 * fields (height / dob / gender / glucose unit / thresholds) are re-read
 * from the DB inside the builder, so the handler only threads id + tz.
 */
export type AuthedUser = Pick<User, "id" | "timezone">;

/**
 * `/api/insights/targets` body. Wrapped in `cachedSwr` by the route so the
 * cold multi-query walk is paid once per 60 s window; writes hard-evict the
 * bucket so user actions reflect on the next read.
 */
export async function buildTargetsResponse(user: AuthedUser) {
  const userId = user.id;
  const timezone = user.timezone ?? DEFAULT_TIMEZONE;
  const queryNow = new Date();
  const types: MeasurementType[] = [
    "WEIGHT",
    "BLOOD_PRESSURE_SYS",
    "BLOOD_PRESSURE_DIA",
    "PULSE",
    "RESTING_HEART_RATE",
    "BODY_FAT",
    "ACTIVITY_STEPS",
  ];
  const thirtyDaysAgo = new Date(queryNow.getTime() - 30 * 24 * 60 * 60 * 1000);
  const oneYearAgo = new Date(queryNow.getTime() - 365 * 24 * 60 * 60 * 1000);
  const moodSince = new Date(
    queryNow.getTime() - 5 * 365 * 24 * 60 * 60 * 1000,
  );

  void ensureUserMoodRollupsFresh(userId);

  // All independent reads stay in one bounded fan-out. The medication event
  // read is the sole dependent query and remains chained to its medication
  // list inside one concurrency slot.
  const limit = pLimit(4);
  const [
    dbUser,
    recentMeasurements,
    latestEverByType,
    sleepStageRows,
    medicationBundle,
    moodRollups,
    latestMoodEntry,
    glucoseRows,
  ] = await Promise.all([
    limit(() =>
      prisma.user.findUnique({
        where: { id: userId },
        select: {
          heightCm: true,
          dateOfBirth: true,
          gender: true,
          glucoseUnit: true,
          hasDiabetes: true,
          thresholdsJson: true,
          sourcePriorityJson: true,
        },
      }),
    ),
    limit(() =>
      prisma.measurement.findMany({
        where: {
          userId,
          type: { in: types },
          measuredAt: { gte: thirtyDaysAgo },
          deletedAt: null,
        },
        orderBy: { measuredAt: "desc" },
        select: { type: true, value: true, measuredAt: true },
      }),
    ),
    limit(() => {
      for (const type of types) {
        if (!/^[A-Z0-9_]+$/.test(type)) {
          throw new Error(`invalid measurement type: ${type}`);
        }
      }
      const typeList = types
        .map((type) => `'${type}'::"measurement_type"`)
        .join(",");
      return prisma.$queryRawUnsafe<
        Array<{ type: MeasurementType; value: number }>
      >(
        `SELECT DISTINCT ON (m."type")
           m."type"::text AS type,
           m."value"      AS value
         FROM measurements m
         WHERE m."user_id" = $1
           AND m."type" IN (${typeList})
           AND m."measured_at" >= $2
           AND m."deleted_at" IS NULL
         ORDER BY m."type" ASC, m."measured_at" DESC`,
        userId,
        oneYearAgo,
      );
    }),
    limit(() =>
      prisma.measurement.findMany({
        where: {
          userId,
          type: "SLEEP_DURATION",
          measuredAt: { gte: thirtyDaysAgo },
          deletedAt: null,
        },
        orderBy: { measuredAt: "asc" },
        select: {
          value: true,
          measuredAt: true,
          sleepStage: true,
          source: true,
          deviceType: true,
        },
      }),
    ),
    limit(async () => {
      const activeMedications = await prisma.medication.findMany({
        where: { userId, active: true, asNeeded: false },
        include: {
          schedules: { select: SCHEDULE_COMPLIANCE_SELECT },
          scheduleRevisions: { orderBy: { validFrom: "asc" } },
          pauseEras: { select: { pausedAt: true, resumedAt: true } },
        },
        orderBy: { name: "asc" },
      });
      if (activeMedications.length === 0) {
        return { activeMedications, intakeEvents: [] };
      }
      const intakeEvents = await prisma.medicationIntakeEvent.findMany({
        where: {
          userId,
          deletedAt: null,
          medicationId: {
            in: activeMedications.map((medication) => medication.id),
          },
          scheduledFor: { gte: thirtyDaysAgo },
        },
        orderBy: { scheduledFor: "desc" },
        select: {
          medicationId: true,
          takenAt: true,
          skipped: true,
          scheduledFor: true,
        },
      });
      return { activeMedications, intakeEvents };
    }),
    limit(() => readMoodDayRollups(userId, moodSince)),
    limit(() =>
      prisma.moodEntry.findFirst({
        where: { userId, deletedAt: null },
        orderBy: { moodLoggedAt: "desc" },
        select: { score: true, moodLoggedAt: true },
      }),
    ),
    limit(() =>
      prisma.measurement.findMany({
        where: {
          userId,
          type: "BLOOD_GLUCOSE",
          measuredAt: { gte: oneYearAgo },
          deletedAt: null,
        },
        orderBy: { measuredAt: "desc" },
        select: { value: true, measuredAt: true, glucoseContext: true },
      }),
    ),
  ]);

  // Rollup coverage fallback stays an explicit repository read here rather
  // than hiding persistence inside the pure mood section builder.
  let recentRawMood: TargetMoodEntry[] | null = null;
  if (moodRollups.length === 0 && latestMoodEntry !== null) {
    const thirtyDaysAgoMood = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    recentRawMood = await prisma.moodEntry.findMany({
      where: {
        userId,
        deletedAt: null,
        moodLoggedAt: { gte: thirtyDaysAgoMood },
      },
      orderBy: { moodLoggedAt: "asc" },
      select: { score: true, moodLoggedAt: true },
    });
  }

  const now = new Date();

  const age = dbUser?.dateOfBirth ? getAge(new Date(dbUser.dateOfBirth)) : null;
  const gender = (dbUser?.gender as "MALE" | "FEMALE" | null) ?? null;
  const heightCm = dbUser?.heightCm ?? null;
  const latestByType: TargetValueByType = {};
  const average30ByType: TargetValueByType = {};
  for (const type of types) {
    latestByType[type] =
      latestEverByType.find((row) => row.type === type)?.value ?? null;
    const recent = recentMeasurements.filter(
      (measurement) => measurement.type === type,
    );
    average30ByType[type] =
      recent.length > 0
        ? Math.round(
            (recent.reduce((sum, measurement) => sum + measurement.value, 0) /
              recent.length) *
              10,
          ) / 10
        : null;
  }

  const vitalSection = buildVitalTargets({
    recentMeasurements,
    latestByType,
    average30ByType,
    heightCm,
    age,
    gender,
    timezone,
    now,
  });
  const sleepTarget = buildSleepTarget({
    sleepStageRows,
    timezone,
    sourcePriorityJson: dbUser?.sourcePriorityJson ?? null,
    now,
  });
  const pulseIndex = vitalSection.targets.findIndex(
    (target) => target.type === "PULSE",
  );
  const targets: TargetItem[] = [
    ...vitalSection.targets.slice(0, pulseIndex + 1),
    sleepTarget,
    ...vitalSection.targets.slice(pulseIndex + 1),
  ];

  const medicationTarget = buildMedicationTarget({
    activeMedications: medicationBundle.activeMedications,
    intakeEvents: medicationBundle.intakeEvents,
    timezone,
    now,
  });
  if (medicationTarget) targets.push(medicationTarget);

  targets.push(
    ...buildMoodTargets({
      moodRollups,
      recentRawMood,
      latestMoodEntry,
      timezone,
      now,
    }),
  );

  const glucoseUnit = resolveGlucoseUnit(dbUser?.glucoseUnit ?? null);
  targets.push(
    ...buildGlucoseTargets({
      rows: glucoseRows,
      profile: {
        heightCm,
        dateOfBirth: dbUser?.dateOfBirth ?? null,
        gender: dbUser?.gender ?? null,
        glucoseUnit: dbUser?.glucoseUnit ?? null,
        hasDiabetes: dbUser?.hasDiabetes ?? false,
        thresholdsJson: (dbUser?.thresholdsJson ??
          null) as ThresholdOverridesJson | null,
      },
      timezone,
      now,
    }),
  );

  const pageSummary = buildTargetPageSummary(targets);
  annotate({
    action: { name: "insights.targets" },
    meta: {
      targetCount: targets.length,
      targetsMetThisWeek: pageSummary.targetsMetThisWeek,
      streakHighlightMetric: pageSummary.streakHighlight?.metric ?? null,
    },
  });

  return {
    targets,
    pageSummary,
    bpDiastolic: {
      current: latestByType.BLOOD_PRESSURE_DIA ?? null,
      average30: average30ByType.BLOOD_PRESSURE_DIA ?? null,
      range: vitalSection.bpRange
        ? {
            min: vitalSection.bpRange.diaLow,
            max: vitalSection.bpRange.diaHigh,
          }
        : null,
    },
    profile: {
      heightCm,
      age,
      gender,
      glucoseUnit,
    },
  };
}
