/**
 * Recompute the cached cycle forecast for one account from the persisted
 * rows, without a request.
 *
 * `CyclePrediction` is not a cache of a read — it is the index the
 * cycle-reminder cron scans to find who is due a period-soon or fertile-soon
 * push. Until v1.35.3 its only writer was `GET /api/cycle/calendar`, which
 * meant the reminders an account received depended on whether somebody had
 * opened the calendar recently, and the write itself was a discarded promise
 * inside a `try {} catch {}` that swallowed the failure. Both ends are fixed
 * here: the refresh runs on the schedule that consumes it, and a failed write
 * throws so the job reports it.
 *
 * The reads mirror the calendar route's default window so the forecast the
 * cron scans and the forecast the calendar renders come out of the same
 * inputs.
 */
import { prisma } from "@/lib/db";
import { predictCycle } from "@/lib/cycle";
import {
  forecastActive,
  toCycleInputs,
  toDayLogInputs,
  toProfileInput,
} from "@/lib/cycle/engine-adapter";
import { persistPredictionCache } from "@/lib/cycle/prediction-cache";
import { addDays } from "@/lib/cycle/day-math";
import { BBT_WINDOW } from "@/lib/cycle/types";
import { moodDateKey } from "@/lib/mood/date-key";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";
import { startOfLocalDayKey } from "@/lib/tz/local-day";

/** Day-log lookback: the calendar's default past span or the symptothermal
 *  window, whichever reaches further back. */
const LOOKBACK_DAYS = Math.max(90, BBT_WINDOW);

/** Wrist/skin-temperature lookback feeding the temperature-trend layer. */
const TEMPERATURE_LOOKBACK_DAYS = 90;

export type PredictionRefreshOutcome =
  /** A forecast was computed and the cache row reflects it. */
  | "persisted"
  /** No profile row, so the account has never touched cycle tracking. */
  | "no-profile"
  /** Prediction is off for this account (raw-chart mode / explicit opt-out),
   *  or the engine had nothing to forecast from. */
  | "no-prediction"
  /** A pregnancy or postpartum state pauses the forecast; the cached
   *  row was removed. */
  | "paused";

/**
 * Recompute and persist the forecast for one account. Throws if the write
 * fails — the caller is a job and owns the failure.
 */
export async function refreshPredictionCacheForUser(
  userId: string,
  now: Date = new Date(),
): Promise<PredictionRefreshOutcome> {
  const [profile, user] = await Promise.all([
    prisma.cycleProfile.findUnique({ where: { userId } }),
    prisma.user.findUnique({
      where: { id: userId },
      select: { timezone: true },
    }),
  ]);
  if (!profile) return "no-profile";
  if (!profile.predictionEnabled || profile.rawChartMode) {
    return "no-prediction";
  }

  const tz = user?.timezone ?? DEFAULT_TIMEZONE;
  const today = moodDateKey(now, tz);

  // A pregnancy or postpartum state pauses the forecast. The cached
  // row is what the reminder cron scans, so a paused account must not keep
  // one: drop it rather than leave last month's forecast answering for a
  // period that is not coming.
  if (!forecastActive(toProfileInput(profile), today)) {
    await prisma.cyclePrediction.deleteMany({ where: { userId } });
    return "paused";
  }

  const [cycles, dayLogs, nightlyTemps] = await Promise.all([
    prisma.menstrualCycle.findMany({
      where: { userId, deletedAt: null },
      orderBy: { startDate: "asc" },
    }),
    prisma.cycleDayLog.findMany({
      where: {
        userId,
        deletedAt: null,
        date: { gte: addDays(today, -LOOKBACK_DAYS) },
      },
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
      },
    }),
    prisma.measurement.findMany({
      where: {
        userId,
        deletedAt: null,
        type: "WRIST_TEMPERATURE",
        measuredAt: {
          gte: startOfLocalDayKey(
            addDays(today, -TEMPERATURE_LOOKBACK_DAYS),
            tz,
          ),
        },
      },
      orderBy: { measuredAt: "asc" },
      select: { measuredAt: true, value: true },
    }),
  ]);

  const nights = nightlyTemps.map((m) => ({
    date: moodDateKey(m.measuredAt, tz),
    valueC: m.value,
  }));

  const prediction = predictCycle(
    toCycleInputs(cycles),
    toDayLogInputs(dayLogs),
    toProfileInput(profile),
    today,
    nights,
  );

  await persistPredictionCache(userId, prediction, now);
  return "persisted";
}
