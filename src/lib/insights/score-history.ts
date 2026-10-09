/**
 * A score's daily course over a chosen window, for the score pages' history
 * chart: the health score, readiness and the sleep score.
 *
 * Each is read from where the day view reads the same score for one day
 * (`src/lib/day/scores.ts`), so a point on the chart and the score tile of
 * the day it opens never disagree:
 *
 *   - Health score: the `HealthScoreRecord` row of each local day, the score
 *     as it was shown that day. Nothing recomputes it.
 *   - Readiness: the `COMPUTED` `RECOVERY_SCORE` rows the nightly job wrote,
 *     filed on the wake day of the night they describe (`wakeDayKeyOf`).
 *   - Sleep score: computed per night against the trailing window that ends
 *     on it, the yardstick the headline uses for its latest night.
 *
 * The health score's line breaks where the recipe changed (Eurostat's `b`
 * flag on the first day under a new recipe): the numbers either side are
 * averages of different things, so the chart draws two segments and never
 * one line through the seam. The algorithm version is part of the recipe
 * here, for the same reason.
 *
 * The usual range is the person's own, the rule the day view's score tiles
 * use (`scoreBand`): median and scaled MAD over the 30 days before the
 * newest point, with at least seven of them, and only from the newest
 * point's side of a seam.
 */
import { prisma } from "@/lib/db";
import { scoreBand } from "@/lib/day/scores";
import { BAND_WINDOW_DAYS } from "@/lib/day/values";
import type { BaselineProfile } from "@/lib/insights/derived/baseline";
import { wakeDayKeyOf } from "@/lib/insights/derived/recovery-resolve";
import { computeSleepScoreHistory } from "@/lib/insights/derived/sleep-score";
import { shiftDateKey, userDayKey } from "@/lib/tz/format";
import { startOfLocalDayKey } from "@/lib/tz/local-day";

import type { ScoreHistoryId } from "./score-history-ids";

const MS_PER_DAY = 86_400_000;
const SCORE_SCALE_MAX = 100;

export interface ScoreHistoryPoint {
  /** The local calendar day the value describes, `YYYY-MM-DD`. */
  day: string;
  /** 0 to 100, whole points. */
  value: number;
  /** True on the first day scored under a different recipe than the day before. */
  seamBreak: boolean;
}

export interface ScoreHistory {
  score: ScoreHistoryId;
  days: number;
  points: ScoreHistoryPoint[];
  band: { lo: number; hi: number; n: number } | null;
}

export interface ScoreHistoryArgs {
  userId: string;
  score: ScoreHistoryId;
  days: number;
  now: Date;
  tz: string;
  /** Read only for the sleep score. */
  profile: () => Promise<BaselineProfile>;
  priorityJson: () => Promise<unknown>;
}

interface DayValue {
  day: string;
  value: number;
  seamBreak: boolean;
}

async function healthScoreDays(
  userId: string,
  from: string,
  to: string,
): Promise<DayValue[]> {
  const rows = await prisma.healthScoreRecord.findMany({
    where: { userId, dayKey: { gte: from, lte: to } },
    orderBy: { dayKey: "asc" },
    select: {
      dayKey: true,
      composite: true,
      configVersion: true,
      scoreVersion: true,
    },
  });
  return rows.map((row, index) => {
    const previous = index > 0 ? rows[index - 1] : null;
    // A row that does not say which recipe produced it cannot support the
    // claim that it shares one with its neighbour, so an unknown version on
    // either side is a seam too.
    const seamBreak =
      previous !== null &&
      (previous.configVersion === null ||
        row.configVersion === null ||
        previous.configVersion !== row.configVersion ||
        previous.scoreVersion !== row.scoreVersion);
    return { day: row.dayKey, value: row.composite, seamBreak };
  });
}

async function readinessDays(
  userId: string,
  from: string,
  to: string,
  tz: string,
): Promise<DayValue[]> {
  // The row is stamped on the day that ended, a day before the wake day it
  // is filed under, so the read opens one day early.
  const rows = await prisma.measurement.findMany({
    where: {
      userId,
      type: "RECOVERY_SCORE",
      source: "COMPUTED",
      deletedAt: null,
      measuredAt: {
        gte: new Date(startOfLocalDayKey(from, tz).getTime() - MS_PER_DAY),
      },
    },
    orderBy: { measuredAt: "asc" },
    select: { value: true, measuredAt: true },
  });
  const byDay = new Map<string, number>();
  for (const row of rows) {
    // A same-night re-score is the later row: ascending order lets it win.
    byDay.set(wakeDayKeyOf(row.measuredAt, "COMPUTED", tz), row.value);
  }
  return [...byDay]
    .filter(([day]) => day >= from && day <= to)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([day, value]) => ({
      day,
      value: Math.round(value),
      seamBreak: false,
    }));
}

async function sleepScoreDays(
  args: ScoreHistoryArgs,
  from: string,
  to: string,
): Promise<DayValue[]> {
  const nights = await computeSleepScoreHistory(
    args.userId,
    await args.profile(),
    {
      fromDay: from,
      now: args.now,
      tz: args.tz,
      priorityJson: await args.priorityJson(),
    },
  );
  return nights
    .filter((night) => night.night <= to)
    .map((night) => ({
      day: night.night,
      value: Math.round(night.score),
      seamBreak: false,
    }));
}

/**
 * The usual range behind the newest point: the values of the 30 days before
 * it, from its own side of the last seam.
 */
function usualBand(values: readonly DayValue[]): ScoreHistory["band"] {
  const newest = values[values.length - 1];
  if (!newest) return null;
  let segmentStart = 0;
  for (let i = values.length - 1; i > 0; i -= 1) {
    if (values[i]!.seamBreak) {
      segmentStart = i;
      break;
    }
  }
  const windowFrom = shiftDateKey(newest.day, -BAND_WINDOW_DAYS);
  const prior = values
    .slice(segmentStart, -1)
    .filter((v) => v.day >= windowFrom)
    .map((v) => v.value);
  return scoreBand(prior, SCORE_SCALE_MAX);
}

export async function readScoreHistory(
  args: ScoreHistoryArgs,
): Promise<ScoreHistory> {
  const today = userDayKey(args.now, args.tz);
  const from = shiftDateKey(today, -(args.days - 1));
  // Read far enough back that the newest day has its 30 days behind it even
  // on a seven-day window.
  const readFrom = shiftDateKey(
    today,
    -Math.max(args.days - 1, BAND_WINDOW_DAYS),
  );

  const values =
    args.score === "HEALTH_SCORE"
      ? await healthScoreDays(args.userId, readFrom, today)
      : args.score === "READINESS"
        ? await readinessDays(args.userId, readFrom, today, args.tz)
        : await sleepScoreDays(args, readFrom, today);

  const points = values.filter((v) => v.day >= from);
  return {
    score: args.score,
    days: args.days,
    // The first point drawn opens no seam of its own: a beginning is not a
    // break.
    points: points.map((point, index) =>
      index === 0 ? { ...point, seamBreak: false } : point,
    ),
    band: points.length > 0 ? usualBand(values) : null,
  };
}
