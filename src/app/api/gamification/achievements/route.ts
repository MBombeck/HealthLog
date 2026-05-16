import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { apiSuccess } from "@/lib/api-response";
import { cached, caches, type ServerCache } from "@/lib/cache/server-cache";
import {
  ACHIEVEMENT_DEFINITIONS,
  GAMIFICATION_ROLLOUT_AT,
  applyDiscoveryFilter,
  calculateLongestStreak,
  evaluateAchievementsWithCompletionDates,
  toBerlinDayKey,
  type AchievementMetrics,
  type AchievementProgress,
} from "@/lib/gamification/achievements";
import {
  buildExpansionMetricValues,
  getEarnabilityFlags,
} from "@/lib/gamification/expansion-metrics";
import {
  classifyBMI,
  classifyBP,
  classifyPulse,
} from "@/lib/analytics/classifications";
import { classifyIntakeTiming } from "@/lib/analytics/compliance";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { resolveServerLocale } from "@/lib/i18n/server-locale";
import type { NextRequest } from "next/server";

interface IosAchievement {
  id: string;
  key: string;
  title: string;
  description: string;
  iconName: string;
  unlocked: boolean;
  unlockedAt: string | null;
  progress: number;
}

export const dynamic = "force-dynamic";

const DAY_MS = 24 * 60 * 60 * 1000;
const ROLLING_WINDOW_DAYS = 30;

type IntakeEventRecord = {
  medicationId: string;
  scheduledFor: Date;
  takenAt: Date | null;
  skipped: boolean;
};

type MedicationScheduleRecord = {
  windowStart: string;
  windowEnd: string;
  daysOfWeek: string | null;
};

type MeasurementRecord = {
  type: "WEIGHT" | "BLOOD_PRESSURE_SYS" | "BLOOD_PRESSURE_DIA" | "PULSE";
  value: number;
  measuredAt: Date;
};

function maxDate(a: Date, b: Date): Date {
  return a > b ? a : b;
}

function dayKeyToSerial(dayKey: string): number {
  const [year, month, day] = dayKey.split("-").map(Number);
  return Date.UTC(year, month - 1, day) / DAY_MS;
}

function serialToDayKey(serial: number): string {
  const date = new Date(serial * DAY_MS);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dayKeyToDate(dayKey: string): Date {
  const [year, month, day] = dayKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function findCountCompletionDate(dates: Date[], target: number): Date | null {
  if (dates.length < target) return null;
  const sorted = [...dates].sort((a, b) => a.getTime() - b.getTime());
  return sorted[target - 1] ?? null;
}

function findStreakCompletionDate(
  dayKeys: string[],
  target: number,
  firstDateByDay: Map<string, Date>,
): Date | null {
  if (dayKeys.length === 0) return null;

  let streak = 1;
  if (target === 1) {
    return firstDateByDay.get(dayKeys[0]) ?? null;
  }

  for (let i = 1; i < dayKeys.length; i++) {
    const previous = dayKeyToSerial(dayKeys[i - 1]);
    const current = dayKeyToSerial(dayKeys[i]);
    streak = current - previous === 1 ? streak + 1 : 1;

    if (streak >= target) {
      return firstDateByDay.get(dayKeys[i]) ?? null;
    }
  }

  return null;
}

function toDaySeries(dayKeys: string[]): {
  dayKeys: string[];
  firstDateByDay: Map<string, Date>;
} {
  const sortedKeys = [...new Set(dayKeys)].sort();
  const firstDateByDay = new Map<string, Date>(
    sortedKeys.map((key) => [key, dayKeyToDate(key)]),
  );

  return {
    dayKeys: sortedKeys,
    firstDateByDay,
  };
}

function getEventDaySeries(dates: Date[]): {
  dayKeys: string[];
  firstDateByDay: Map<string, Date>;
} {
  const firstDateByDay = new Map<string, Date>();

  for (const date of dates) {
    const dayKey = toBerlinDayKey(date);
    const existing = firstDateByDay.get(dayKey);

    if (!existing || date < existing) {
      firstDateByDay.set(dayKey, date);
    }
  }

  return {
    dayKeys: Array.from(firstDateByDay.keys()).sort(),
    firstDateByDay,
  };
}

function getHealthGreenDaySeries(
  measurements: MeasurementRecord[],
  heightCm: number | null,
) {
  const dayStats = new Map<
    string,
    {
      weight: number[];
      bpSys: number[];
      bpDia: number[];
      pulse: number[];
    }
  >();

  for (const measurement of measurements) {
    const dayKey = toBerlinDayKey(measurement.measuredAt);
    const bucket = dayStats.get(dayKey) ?? {
      weight: [],
      bpSys: [],
      bpDia: [],
      pulse: [],
    };

    if (measurement.type === "WEIGHT") bucket.weight.push(measurement.value);
    if (measurement.type === "BLOOD_PRESSURE_SYS")
      bucket.bpSys.push(measurement.value);
    if (measurement.type === "BLOOD_PRESSURE_DIA")
      bucket.bpDia.push(measurement.value);
    if (measurement.type === "PULSE") bucket.pulse.push(measurement.value);

    dayStats.set(dayKey, bucket);
  }

  const bmiGreenDays: string[] = [];
  const bpGreenDays: string[] = [];
  const pulseGreenDays: string[] = [];

  for (const [dayKey, bucket] of dayStats.entries()) {
    if (heightCm && bucket.weight.length > 0) {
      const bmi = mean(bucket.weight) / (heightCm / 100) ** 2;
      if (classifyBMI(bmi).severity === "normal") {
        bmiGreenDays.push(dayKey);
      }
    }

    if (bucket.bpSys.length > 0 && bucket.bpDia.length > 0) {
      const bpClass = classifyBP(mean(bucket.bpSys), mean(bucket.bpDia));
      if (bpClass.severity === "normal") {
        bpGreenDays.push(dayKey);
      }
    }

    if (bucket.pulse.length > 0) {
      const pulseClass = classifyPulse(mean(bucket.pulse));
      if (pulseClass.severity === "normal") {
        pulseGreenDays.push(dayKey);
      }
    }
  }

  return {
    bmi: toDaySeries(bmiGreenDays),
    bp: toDaySeries(bpGreenDays),
    pulse: toDaySeries(pulseGreenDays),
  };
}

function getOnTimePerfectDaySeries(
  intakeEvents: IntakeEventRecord[],
  schedulesByMedicationId: Map<string, MedicationScheduleRecord[]>,
) {
  const eventsByDay = new Map<string, IntakeEventRecord[]>();

  for (const event of intakeEvents) {
    const dayKey = toBerlinDayKey(event.scheduledFor);
    const list = eventsByDay.get(dayKey) ?? [];
    list.push(event);
    eventsByDay.set(dayKey, list);
  }

  const perfectDays: string[] = [];

  for (const [dayKey, events] of eventsByDay.entries()) {
    if (events.length === 0) continue;

    const scheduledDate = dayKeyToDate(dayKey);
    let isPerfectDay = true;

    for (const event of events) {
      if (event.skipped || event.takenAt === null) {
        isPerfectDay = false;
        break;
      }

      const schedules = schedulesByMedicationId.get(event.medicationId) ?? [];
      if (schedules.length === 0) {
        continue;
      }

      const eventMinutes =
        event.scheduledFor.getUTCHours() * 60 +
        event.scheduledFor.getUTCMinutes();

      let bestSchedule = schedules[0];
      let bestDistance = Infinity;

      for (const schedule of schedules) {
        const [h, m] = schedule.windowStart.split(":").map(Number);
        const scheduleMinutes = h * 60 + m;
        const distance = Math.abs(eventMinutes - scheduleMinutes);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestSchedule = schedule;
        }
      }

      const timing = classifyIntakeTiming(
        event.takenAt,
        bestSchedule.windowStart,
        bestSchedule.windowEnd,
        scheduledDate,
      );

      // v1.4.34 IW-C — `early` is also a compliant bucket (dose taken
      // within the 3h pre-window grace), so it preserves a perfect day.
      if (timing !== "on_time" && timing !== "early") {
        isPerfectDay = false;
        break;
      }
    }

    if (isPerfectDay) {
      perfectDays.push(dayKey);
    }
  }

  return toDaySeries(perfectDays);
}

function parseDaysOfWeek(daysOfWeek: string | null): Set<number> | null {
  if (!daysOfWeek) return null;

  const values = daysOfWeek
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value >= 0 && value <= 6);

  return values.length > 0 ? new Set(values) : null;
}

function getExpectedIntakesForDay(
  schedules: MedicationScheduleRecord[],
  dayKey: string,
): number {
  if (schedules.length === 0) return 0;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) return 0;

  const day = dayKeyToDate(dayKey).getUTCDay();
  let expected = 0;

  for (const schedule of schedules) {
    const allowedDays = parseDaysOfWeek(schedule.daysOfWeek);
    if (!allowedDays || allowedDays.has(day)) {
      expected += 1;
    }
  }

  return expected;
}

function getIntakeIssueMetrics(
  intakeEvents: IntakeEventRecord[],
  schedulesByMedicationId: Map<string, MedicationScheduleRecord[]>,
) {
  const skippedIntakeDates = intakeEvents
    .filter((event) => event.skipped)
    .map((event) => event.scheduledFor)
    .sort((a, b) => a.getTime() - b.getTime());

  const eventsByMedicationDay = new Map<
    string,
    Map<string, IntakeEventRecord[]>
  >();

  for (const event of intakeEvents) {
    if (!event.medicationId || Number.isNaN(event.scheduledFor.getTime())) {
      continue;
    }

    const dayKey = toBerlinDayKey(event.scheduledFor);
    const byDay = eventsByMedicationDay.get(event.medicationId) ?? new Map();
    const list = byDay.get(dayKey) ?? [];
    list.push(event);
    byDay.set(dayKey, list);
    eventsByMedicationDay.set(event.medicationId, byDay);
  }

  let overIntakeCount = 0;
  const overIntakeDates: Date[] = [];

  for (const [medicationId, dayMap] of eventsByMedicationDay.entries()) {
    const schedules = schedulesByMedicationId.get(medicationId) ?? [];

    for (const [dayKey, events] of dayMap.entries()) {
      const expectedCount = getExpectedIntakesForDay(schedules, dayKey);

      if (expectedCount <= 0) {
        continue;
      }

      const takenEvents = events
        .filter((event) => !event.skipped && event.takenAt !== null)
        .sort((a, b) => {
          const aTime = (a.takenAt ?? a.scheduledFor).getTime();
          const bTime = (b.takenAt ?? b.scheduledFor).getTime();
          return aTime - bTime;
        });

      const excessCount = Math.max(0, takenEvents.length - expectedCount);
      if (excessCount === 0) {
        continue;
      }

      overIntakeCount += excessCount;

      for (
        let index = takenEvents.length - excessCount;
        index < takenEvents.length;
        index++
      ) {
        const event = takenEvents[index];
        if (!event) continue;
        overIntakeDates.push(event.takenAt ?? event.scheduledFor);
      }
    }
  }

  overIntakeDates.sort((a, b) => a.getTime() - b.getTime());

  return {
    skippedIntakeCount: skippedIntakeDates.length,
    skippedIntakeDates,
    overIntakeCount,
    overIntakeDates,
  };
}

function getCompliance80DaySeries(
  intakeEvents: IntakeEventRecord[],
  startDate: Date,
  endDate: Date,
) {
  const perDayCounts = new Map<number, { logged: number; taken: number }>();

  for (const event of intakeEvents) {
    const serial = dayKeyToSerial(toBerlinDayKey(event.scheduledFor));
    const current = perDayCounts.get(serial) ?? { logged: 0, taken: 0 };

    const logged = event.skipped || event.takenAt !== null;
    const taken = !event.skipped && event.takenAt !== null;

    if (logged) current.logged += 1;
    if (taken) current.taken += 1;

    perDayCounts.set(serial, current);
  }

  const startSerial = dayKeyToSerial(toBerlinDayKey(startDate));
  const endSerial = dayKeyToSerial(toBerlinDayKey(endDate));

  let rollingLogged = 0;
  let rollingTaken = 0;
  const greenDays: string[] = [];

  for (let serial = startSerial; serial <= endSerial; serial++) {
    const todayCounts = perDayCounts.get(serial);
    if (todayCounts) {
      rollingLogged += todayCounts.logged;
      rollingTaken += todayCounts.taken;
    }

    const outOfWindowCounts = perDayCounts.get(serial - ROLLING_WINDOW_DAYS);
    if (outOfWindowCounts) {
      rollingLogged -= outOfWindowCounts.logged;
      rollingTaken -= outOfWindowCounts.taken;
    }

    const hasFullWindow = serial >= startSerial + (ROLLING_WINDOW_DAYS - 1);
    if (!hasFullWindow || rollingLogged <= 0) continue;

    const compliance = Math.round((rollingTaken / rollingLogged) * 100);
    if (compliance >= 80) {
      greenDays.push(serialToDayKey(serial));
    }
  }

  return toDaySeries(greenDays);
}

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  const formatParam = request.nextUrl.searchParams.get("format");
  const isIosFormat = formatParam === "ios";
  annotate({
    action: { name: "gamification.achievements" },
    meta: { format: isIosFormat ? "ios" : "default" },
  });

  // v1.4.34 IW-G — cache the web-shape result keyed on userId. The
  // iOS-format branch runs the locale-aware transform after the cache
  // read so the cache stays format-agnostic and the achievement-progress
  // dashboard duplicate (seen twice per dashboard mount in the v1.4.33
  // HAR) coalesces into one builder call. Newly-unlocked achievements
  // get persisted inside the builder so the second concurrent mount
  // observes the up-to-date `persisted` state.
  const result = await cached(
    caches.achievements as ServerCache<AchievementsResult>,
    user.id,
    () => buildAchievementsResult(user),
    annotate,
  );

  if (isIosFormat) {
    const locale = await resolveServerLocale({
      request,
      userLocale: user.locale,
    });
    const t = getServerTranslator(locale);
    const ios: IosAchievement[] = result.achievements.map((a) => ({
      id: a.id,
      key: a.id,
      title: t.t(a.titleKey),
      description: t.t(a.descriptionKey),
      iconName: a.icon,
      unlocked: a.unlocked,
      unlockedAt: a.completedAt,
      progress: Math.max(0, Math.min(1, a.progressPercent / 100)),
    }));
    return apiSuccess(ios);
  }

  return apiSuccess(result);
});

type AuthedUser = Awaited<ReturnType<typeof requireAuth>>["user"];

type AchievementsResult = Awaited<ReturnType<typeof buildAchievementsResult>>;

/**
 * v1.4.34 IW-G — pulled out of the GET handler so `cached()` can wrap
 * the heavy aggregation. Returns the locale-agnostic web payload; the
 * iOS-format transform runs in the handler after the cache read.
 *
 * `prisma.userAchievement.createMany` inside the builder is kept here
 * (rather than moved to the cache hit path) because new unlocks are
 * a side effect of the same aggregate computation. A duplicate concurrent
 * read coalesces through the cache's single-flight `pending` map so the
 * createMany only fires once.
 */
async function buildAchievementsResult(user: AuthedUser) {
  const now = new Date();
  const userId = user.id;
  const startDate = maxDate(user.createdAt, GAMIFICATION_ROLLOUT_AT);

  const [
    measurements,
    intakeEvents,
    medications,
    passkeys,
    auditEvents,
    moodEntries,
  ] = await Promise.all([
    prisma.measurement.findMany({
      where: {
        userId,
        measuredAt: { gte: startDate, lte: now },
        source: { not: "IMPORT" },
        type: {
          in: ["WEIGHT", "BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA", "PULSE"],
        },
      },
      select: {
        type: true,
        value: true,
        measuredAt: true,
      },
    }),
    prisma.medicationIntakeEvent.findMany({
      where: {
        userId,
        source: { not: "IMPORT" },
        scheduledFor: { gte: startDate, lte: now },
      },
      select: {
        medicationId: true,
        scheduledFor: true,
        takenAt: true,
        skipped: true,
      },
    }),
    prisma.medication.findMany({
      where: { userId },
      select: {
        id: true,
        schedules: {
          select: {
            windowStart: true,
            windowEnd: true,
            daysOfWeek: true,
          },
        },
      },
    }),
    prisma.passkey.findMany({
      where: {
        userId,
        createdAt: { gte: startDate, lte: now },
      },
      select: {
        createdAt: true,
      },
    }),
    prisma.auditLog.findMany({
      where: {
        userId,
        createdAt: { gte: startDate, lte: now },
        action: {
          in: [
            "auth.login.passkey",
            "auth.login.password",
            "bugreport.submit",
            // v1.4.18 — hidden Easter-egg triggers
            "doctor-report.generate",
            "doctor-report.pdf.generate",
            "settings.locale.update",
          ],
        },
      },
      select: {
        action: true,
        createdAt: true,
      },
    }),
    // v1.4.18 — mood entries feed the new mood badges + the
    // entry-streak/consistent-month engagement metrics. Synced from
    // moodLog.app or entered directly; we intentionally include all
    // sources because consistency-of-tracking is what the badge
    // rewards.
    prisma.moodEntry.findMany({
      where: {
        userId,
        moodLoggedAt: { gte: startDate, lte: now },
      },
      select: {
        date: true,
        score: true,
        moodLoggedAt: true,
      },
    }),
  ]);

  const schedulesByMedicationId = new Map(
    medications.map((med) => [med.id, med.schedules]),
  );
  const intakeIssueMetrics = getIntakeIssueMetrics(
    intakeEvents,
    schedulesByMedicationId,
  );

  const takenIntakeDates = intakeEvents
    .filter((event) => !event.skipped && event.takenAt !== null)
    .map((event) => event.takenAt as Date);
  const passkeyCreatedDates = passkeys.map((passkey) => passkey.createdAt);
  const passkeyLoginDates = auditEvents
    .filter((event) => event.action === "auth.login.passkey")
    .map((event) => event.createdAt);
  const passwordLoginDates = auditEvents
    .filter((event) => event.action === "auth.login.password")
    .map((event) => event.createdAt);
  const bugReportDates = auditEvents
    .filter((event) => event.action === "bugreport.submit")
    .map((event) => event.createdAt);
  const loginDaySeries = getEventDaySeries([
    ...passkeyLoginDates,
    ...passwordLoginDates,
  ]);

  const healthSeries = getHealthGreenDaySeries(
    measurements as MeasurementRecord[],
    user.heightCm,
  );
  const onTimeSeries = getOnTimePerfectDaySeries(
    intakeEvents,
    schedulesByMedicationId,
  );
  const complianceSeries = getCompliance80DaySeries(
    intakeEvents,
    startDate,
    now,
  );

  const expansionValues = buildExpansionMetricValues({
    measurements,
    moodEntries,
    intakeEvents,
    auditEvents,
  });
  const earnability = getEarnabilityFlags({
    hasMedication: medications.length > 0,
    moodEntryCount: expansionValues.moodEntryCount,
    measurementCounts: {
      weightCount: expansionValues.weightMeasurementCount,
      bpCount: expansionValues.bpMeasurementCount,
      pulseCount: expansionValues.pulseMeasurementCount,
    },
  });

  const metrics = {
    totalTakenIntakes: takenIntakeDates.length,
    overIntakeCount: intakeIssueMetrics.overIntakeCount,
    skippedIntakeCount: intakeIssueMetrics.skippedIntakeCount,
    bmiGreenStreak: calculateLongestStreak(healthSeries.bmi.dayKeys),
    bpGreenStreak: calculateLongestStreak(healthSeries.bp.dayKeys),
    pulseGreenStreak: calculateLongestStreak(healthSeries.pulse.dayKeys),
    onTimePerfectDayStreak: calculateLongestStreak(onTimeSeries.dayKeys),
    compliance80DayStreak: calculateLongestStreak(complianceSeries.dayKeys),
    passkeyCreatedCount: passkeyCreatedDates.length,
    passkeyLoginCount: passkeyLoginDates.length,
    passwordLoginCount: passwordLoginDates.length,
    loginDayStreak: calculateLongestStreak(loginDaySeries.dayKeys),
    bugReportCount: bugReportDates.length,
    ...expansionValues,
  };

  const completionDates: Partial<Record<string, Date>> = {};

  for (const definition of ACHIEVEMENT_DEFINITIONS) {
    if (definition.metric === "totalTakenIntakes") {
      const completedAt = findCountCompletionDate(
        takenIntakeDates,
        definition.target,
      );
      if (completedAt) completionDates[definition.id] = completedAt;
      continue;
    }

    if (definition.metric === "passkeyCreatedCount") {
      const completedAt = findCountCompletionDate(
        passkeyCreatedDates,
        definition.target,
      );
      if (completedAt) completionDates[definition.id] = completedAt;
      continue;
    }

    if (definition.metric === "passkeyLoginCount") {
      const completedAt = findCountCompletionDate(
        passkeyLoginDates,
        definition.target,
      );
      if (completedAt) completionDates[definition.id] = completedAt;
      continue;
    }

    if (definition.metric === "passwordLoginCount") {
      const completedAt = findCountCompletionDate(
        passwordLoginDates,
        definition.target,
      );
      if (completedAt) completionDates[definition.id] = completedAt;
      continue;
    }

    if (definition.metric === "bugReportCount") {
      const completedAt = findCountCompletionDate(
        bugReportDates,
        definition.target,
      );
      if (completedAt) completionDates[definition.id] = completedAt;
      continue;
    }

    if (definition.metric === "overIntakeCount") {
      const completedAt = findCountCompletionDate(
        intakeIssueMetrics.overIntakeDates,
        definition.target,
      );
      if (completedAt) completionDates[definition.id] = completedAt;
      continue;
    }

    if (definition.metric === "skippedIntakeCount") {
      const completedAt = findCountCompletionDate(
        intakeIssueMetrics.skippedIntakeDates,
        definition.target,
      );
      if (completedAt) completionDates[definition.id] = completedAt;
      continue;
    }

    if (definition.metric === "loginDayStreak") {
      const completedAt = findStreakCompletionDate(
        loginDaySeries.dayKeys,
        definition.target,
        loginDaySeries.firstDateByDay,
      );
      if (completedAt) completionDates[definition.id] = completedAt;
      continue;
    }

    if (definition.metric === "bmiGreenStreak") {
      const completedAt = findStreakCompletionDate(
        healthSeries.bmi.dayKeys,
        definition.target,
        healthSeries.bmi.firstDateByDay,
      );
      if (completedAt) completionDates[definition.id] = completedAt;
      continue;
    }

    if (definition.metric === "bpGreenStreak") {
      const completedAt = findStreakCompletionDate(
        healthSeries.bp.dayKeys,
        definition.target,
        healthSeries.bp.firstDateByDay,
      );
      if (completedAt) completionDates[definition.id] = completedAt;
      continue;
    }

    if (definition.metric === "pulseGreenStreak") {
      const completedAt = findStreakCompletionDate(
        healthSeries.pulse.dayKeys,
        definition.target,
        healthSeries.pulse.firstDateByDay,
      );
      if (completedAt) completionDates[definition.id] = completedAt;
      continue;
    }

    if (definition.metric === "onTimePerfectDayStreak") {
      const completedAt = findStreakCompletionDate(
        onTimeSeries.dayKeys,
        definition.target,
        onTimeSeries.firstDateByDay,
      );
      if (completedAt) completionDates[definition.id] = completedAt;
      continue;
    }

    if (definition.metric === "compliance80DayStreak") {
      const completedAt = findStreakCompletionDate(
        complianceSeries.dayKeys,
        definition.target,
        complianceSeries.firstDateByDay,
      );
      if (completedAt) completionDates[definition.id] = completedAt;
    }
  }

  // Load persisted achievements
  const persisted = await prisma.userAchievement.findMany({
    where: { userId },
    select: { achievementId: true, unlockedAt: true },
  });
  const persistedMap = new Map(
    persisted.map((p) => [p.achievementId, p.unlockedAt]),
  );

  // Merge: persisted dates take priority, then calculated dates
  for (const [id, date] of Object.entries(completionDates)) {
    if (!persistedMap.has(id) && date) {
      persistedMap.set(id, date);
    }
  }

  // Use persisted dates as the source of truth
  const mergedDates: Partial<Record<string, Date>> = {};
  for (const [id, date] of persistedMap) {
    mergedDates[id] = date;
  }

  const fullResult = evaluateAchievementsWithCompletionDates(
    metrics,
    mergedDates,
  );

  // Persist newly unlocked achievements
  const newUnlocks = fullResult.achievements.filter(
    (a) =>
      a.unlocked &&
      a.completedAt &&
      !persisted.some((p) => p.achievementId === a.id),
  );
  if (newUnlocks.length > 0) {
    await prisma.userAchievement.createMany({
      data: newUnlocks.map((a) => ({
        userId,
        achievementId: a.id,
        unlockedAt: new Date(a.completedAt!),
      })),
      skipDuplicates: true,
    });
  }

  // v1.4.18 — apply the discovery filter so locked badges that the
  // user has *no path* to earn (e.g. mood badges for someone who has
  // never logged a mood entry) don't clutter the page. Hidden Easter-
  // eggs always pass through. Already-unlocked badges always pass
  // through (regression guard).
  const visibleAchievements = applyDiscoveryFilter(
    fullResult.achievements,
    earnability,
  );

  // Recompute the summary so the headline counters reflect the
  // discovered set. Hidden achievements that are still locked are
  // counted toward `totalCount` so the user sees they exist.
  const visibleUnlocked = visibleAchievements.filter((a) => a.unlocked);
  const visibleEarned = visibleUnlocked.reduce((acc, a) => acc + a.points, 0);
  const visibleTotalPoints = visibleAchievements.reduce(
    (acc, a) => acc + a.points,
    0,
  );
  const nextAchievement =
    visibleAchievements
      .filter((a) => !a.unlocked && !a.isHidden)
      .sort((a, b) => b.progressPercent - a.progressPercent)[0] ?? null;

  // v1.4.18 reconcile — redact hidden+locked entries before serialising
  // so a curious user opening DevTools/Network can't read the trigger
  // semantics from `metric`, `titleKey`, `descriptionKey`, `icon`,
  // `target`, `current`, or `progressPercent`. The DOM render path
  // already short-circuits on `isHidden && !unlocked`; this closes the
  // wire-shape leak. Once an Easter-egg unlocks, the real fields ship
  // (the unlock IS the moment to reveal the surprise).
  const redactedAchievements = visibleAchievements.map((a) =>
    redactIfHiddenLocked(a),
  );
  const redactedNextAchievement = nextAchievement
    ? redactIfHiddenLocked(nextAchievement)
    : null;
  const redactedMetrics = redactHiddenMetrics(
    fullResult.metrics,
    visibleAchievements,
  );

  const result = {
    summary: {
      unlockedCount: visibleUnlocked.length,
      totalCount: visibleAchievements.length,
      earnedPoints: visibleEarned,
      totalPoints: visibleTotalPoints,
      completionPercent:
        visibleAchievements.length === 0
          ? 100
          : Math.round(
              (visibleUnlocked.length / visibleAchievements.length) * 100,
            ),
      nextAchievement: redactedNextAchievement,
    },
    achievements: redactedAchievements,
    metrics: redactedMetrics,
  };

  return result;
}

/**
 * Hidden Easter-eggs ship to the client *only* as opaque cards while
 * locked. Returning the full `AchievementProgress` shape would let a
 * snooper read the trigger semantics from `metric`, `titleKey`, etc.
 * This helper projects locked+hidden entries down to the safe shape
 * the UI's opaque-placeholder branch needs.
 *
 * Unlocked hidden achievements pass through unchanged — the unlock IS
 * the reveal moment, so the toast and the unlocked card show the real
 * strings.
 */
function redactIfHiddenLocked(
  achievement: AchievementProgress,
): AchievementProgress {
  if (!achievement.isHidden || achievement.unlocked) return achievement;
  return {
    id: achievement.id,
    metric: "totalTakenIntakes",
    category: "hidden",
    titleKey: "achievements.hiddenCard.title",
    descriptionKey: "achievements.hiddenCard.description",
    icon: "HelpCircle",
    format: "count",
    target: 0,
    current: 0,
    points: achievement.points,
    unlocked: false,
    progressPercent: 0,
    completedAt: null,
    isHidden: true,
  };
}

/**
 * Drop hidden-only metric counters from the response `metrics` block
 * unless any hidden achievement they back is unlocked. The DOM never
 * reads these counters today — the only consumer is the iOS client's
 * progress bar — so removing the hidden ones from the wire is a pure
 * spoiler shield with zero UI impact.
 */
function redactHiddenMetrics(
  metrics: AchievementMetrics,
  achievements: AchievementProgress[],
): Partial<AchievementMetrics> {
  const HIDDEN_METRIC_KEYS = [
    "nightOwlCount",
    "earlyBirdCount",
    "leapDayCount",
    "doctorPdfCount",
    "localeFlipCount",
  ] as const;
  const safe: Partial<AchievementMetrics> = { ...metrics };
  for (const key of HIDDEN_METRIC_KEYS) {
    const backing = achievements.find(
      (a) => a.isHidden && a.metric === key && a.unlocked,
    );
    if (!backing) {
      delete safe[key];
    }
  }
  return safe;
}
