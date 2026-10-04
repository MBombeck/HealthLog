/**
 * Today's place in the cycle, for the dashboard's Today overview.
 *
 * The cycle page is the one place that decides what may be said about today
 * (`resolveCycleVerdict` over the calendar grid). This read runs the same two
 * steps over the same rows, narrowed to what a one-line summary needs, so the
 * dashboard can never call a day something the cycle page does not: the same
 * still-learning gate withholds the phase, the same ceiling stops the count
 * once a cycle runs past its typical length.
 *
 * Read-only: no profile upsert, no forecast write. The caller has already
 * confirmed the cycle module is on for the record.
 */
import { prisma } from "@/lib/db";
import { buildCalendar, type CalendarDayLogRow } from "./engine-adapter";
import { addDays, dayDiff } from "./day-math";
import { goalAllowsFertileWindow } from "./dto";
import { BBT_WINDOW, type CyclePhase } from "./types";
import { resolveCycleVerdict } from "./verdict";
import { moodDateKey } from "@/lib/mood/date-key";
import { startOfLocalDayKey } from "@/lib/tz/local-day";

/** How far back the grid reaches; the calendar route's default span. */
const PAST_DAYS = 90;

export interface TodayCycleRead {
  dayOfCycle: number;
  /** Null while the engine is still learning the cycle. */
  phase: CyclePhase | null;
}

export async function readTodayCycle(
  userId: string,
  timezone: string,
  now: Date,
): Promise<TodayCycleRead | null> {
  const today = moodDateKey(now, timezone);
  const from = addDays(today, -PAST_DAYS);
  const logFrom =
    dayDiff(from, addDays(today, -BBT_WINDOW)) <= 0
      ? from
      : addDays(today, -BBT_WINDOW);

  const [profile, cycles, dayLogRows, nightlyTemps] = await Promise.all([
    prisma.cycleProfile.findUnique({ where: { userId } }),
    prisma.menstrualCycle.findMany({
      where: { userId, deletedAt: null },
      orderBy: { startDate: "asc" },
    }),
    prisma.cycleDayLog.findMany({
      where: { userId, deletedAt: null, date: { gte: logFrom } },
      orderBy: { date: "asc" },
      select: {
        date: true,
        flow: true,
        basalBodyTempC: true,
        temperatureExcluded: true,
        ovulationTest: true,
        cervicalMucus: true,
        cervixPosition: true,
        cervixFirmness: true,
        cervixOpening: true,
        intermenstrualBleeding: true,
      },
    }),
    prisma.measurement.findMany({
      where: {
        userId,
        deletedAt: null,
        type: "WRIST_TEMPERATURE",
        measuredAt: { gte: startOfLocalDayKey(addDays(today, -90), timezone) },
      },
      orderBy: { measuredAt: "asc" },
      select: { measuredAt: true, value: true },
    }),
  ]);
  if (!profile || cycles.length === 0) return null;

  // The intent fields and the presence flags never reach a phase or a day
  // count; the grid carries them for the calendar's own overlay only.
  const dayLogs: CalendarDayLogRow[] = dayLogRows.map((row) => ({
    ...row,
    hasSymptoms: false,
    hasNote: false,
    sexualActivity: false,
    pregnancyTest: null,
    progesteroneTest: null,
    contraceptive: null,
  }));
  const nights = nightlyTemps.map((m) => ({
    date: moodDateKey(m.measuredAt, timezone),
    valueC: m.value,
  }));

  const { prediction, days } = buildCalendar(
    profile,
    cycles,
    dayLogs,
    nights,
    from,
    today,
    today,
    goalAllowsFertileWindow(profile.goal),
  );
  const verdict = resolveCycleVerdict({
    days,
    today,
    profile: {
      typicalCycleLength: profile.typicalCycleLength,
      typicalPeriodLength: profile.typicalPeriodLength,
      lutealPhaseLength: profile.lutealPhaseLength,
    },
    nextPeriodStart: prediction?.nextPeriodStart ?? null,
    lastPeriodStart:
      cycles.filter((c) => c.startDate <= today).at(-1)?.startDate ?? null,
  });

  if (verdict.state !== "IN_CYCLE" || verdict.dayOfCycle === null) return null;
  return { dayOfCycle: verdict.dayOfCycle, phase: verdict.phase };
}
