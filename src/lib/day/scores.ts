/**
 * The scores of one local day (v1.42, #613): the health score, readiness,
 * a device's recovery, the sleep score and strain, each read from where its
 * own page reads its history, never recomputed per day where a stored value
 * exists.
 *
 *   - Health score: the `HealthScoreRecord` row of that local day, the score
 *     as it was shown that day. Nothing recomputes it.
 *   - Readiness: the `COMPUTED` `RECOVERY_SCORE` row the nightly job wrote
 *     for the night that ended on this morning, the history the readiness
 *     page draws (`readReadinessHistory`). The row is stamped on the day that
 *     ended, so it is read on its wake day (`wakeDayKeyOf`).
 *   - Recovery: the canonical recovery of that wake day
 *     (`resolveCanonicalRecovery`, WHOOP before Oura before Polar before the
 *     proxy), sent only when a device wins. The proxy is the readiness blend
 *     verbatim, so sending it under a second name would show one number
 *     twice; the Coach drops it for the same reason.
 *   - Sleep score: the only one computed live, as its page computes it, over
 *     the 30 nights up to this one. One bounded read of the sleep rows; its
 *     own series carries the nights before, so the usual range costs nothing
 *     more.
 *   - Strain: the `COMPUTED` `STRAIN_SCORE` of the day, else the device's
 *     `DAY_STRAIN` folded to one value per local day the way the strain page
 *     folds it (`deviceStrainDays`), on the device's own 0 to 21 scale.
 *
 * The usual range is the person's own: median and scaled MAD over the 30
 * days before, with at least {@link MIN_BAND_DAYS} days behind it, the same
 * rule the value tiles use. It describes, it does not grade.
 */
import type { MeasurementSource } from "@/generated/prisma/enums";

import {
  DAY_SCORE_KEYS,
  type DayScore,
  type DayScoreKey,
} from "@/lib/day/contract";
import { MIN_BAND_DAYS, BAND_WINDOW_DAYS } from "@/lib/day/values";
import { prisma } from "@/lib/db";
import { buildBaselineBand } from "@/lib/insights/derived/baseline";
import {
  resolveCanonicalRecovery,
  wakeDayKeyOf,
} from "@/lib/insights/derived/recovery-resolve";
import { computeSleepScore } from "@/lib/insights/derived/sleep-score";
import {
  DEVICE_STRAIN_SCALE_MAX,
  deviceStrainDays,
} from "@/lib/insights/derived/wellness-scores";
import { getAgeFromDateOfBirth } from "@/lib/analytics/pulse-targets";
import type { ModuleKey } from "@/lib/modules/registry";
import { surfaceModule } from "@/lib/modules/surface";
import { dateOnlyKey } from "@/lib/tz/date-only";
import { shiftDateKey, userDayKey } from "@/lib/tz/format";
import { localDayWindow, startOfLocalDayKey } from "@/lib/tz/local-day";

const MS_PER_DAY = 86_400_000;

/** The scale of every score but a device's day strain. */
const SCORE_SCALE_MAX = 100;

/**
 * The measurement types the scores section shows in place of the values: a
 * stored score is read on the day it describes here, so it does not also
 * stand among the readings on the day it happens to be stamped.
 */
export const DAY_SCORE_MEASUREMENT_TYPES: ReadonlySet<string> = new Set([
  "RECOVERY_SCORE",
  "STRAIN_SCORE",
  "DAY_STRAIN",
]);

/**
 * The module each score follows, from the one surface map (`derived:<id>`).
 * The health score is core and follows none.
 */
const SCORE_SURFACE: Readonly<Record<DayScoreKey, string | null>> = {
  healthScore: null,
  readiness: "derived:READINESS",
  recovery: "derived:RECOVERY_SCORE",
  sleepScore: "derived:SLEEP_SCORE",
  strain: "derived:STRAIN_SCORE",
};

export function dayScoreVisible(
  key: DayScoreKey,
  modules: Readonly<Record<ModuleKey, boolean>>,
): boolean {
  const surface = SCORE_SURFACE[key];
  if (surface === null) return true;
  const owner = surfaceModule(surface);
  return owner === undefined || owner === null || modules[owner] !== false;
}

/**
 * The person's usual range from the daily values before the day, or null
 * with fewer than {@link MIN_BAND_DAYS} of them. The edges stay on the
 * scale and at least one display step apart.
 */
export function scoreBand(
  prior: readonly number[],
  max: number,
): DayScore["band"] {
  if (prior.length < MIN_BAND_DAYS) return null;
  const band = buildBaselineBand([...prior], null);
  if (!band) return null;
  const step = max === SCORE_SCALE_MAX ? 1 : 0.1;
  const half = Math.max((band.high - band.low) / 2, step);
  const round = (n: number) =>
    step === 1 ? Math.round(n) : Math.round(n * 10) / 10;
  return {
    lo: round(Math.max(0, band.center - half)),
    hi: round(Math.min(max, band.center + half)),
    n: band.sampleDays,
  };
}

function score(
  key: DayScoreKey,
  value: number,
  max: number,
  source: string,
  prior: readonly number[],
): DayScore {
  const shown =
    max === SCORE_SCALE_MAX ? Math.round(value) : Math.round(value * 10) / 10;
  return { key, value: shown, max, source, band: scoreBand(prior, max) };
}

/** Daily values strictly before `day` and on or after `from`, keyed by day. */
function priorValues(
  byDay: ReadonlyMap<string, number>,
  from: string,
  day: string,
): number[] {
  const out: number[] = [];
  for (const [key, value] of byDay) {
    if (key >= from && key < day) out.push(value);
  }
  return out;
}

export interface DayScoresArgs {
  userId: string;
  day: string;
  tz: string;
  modules: Readonly<Record<ModuleKey, boolean>>;
  /** The record's source priority, already read by the day loader. */
  priorityJson: unknown;
  /** The earliest instant a comparison may read (a lookback limit). */
  floor?: Date | null;
}

/** The recovery-module scores: readiness, a device's recovery, strain. */
async function wellnessScores(
  args: DayScoresArgs,
  windowFrom: string,
  windowStart: Date,
  dayEnd: Date,
): Promise<Partial<Record<DayScoreKey, DayScore>>> {
  const rows = await prisma.measurement.findMany({
    where: {
      userId: args.userId,
      deletedAt: null,
      type: { in: ["RECOVERY_SCORE", "STRAIN_SCORE", "DAY_STRAIN"] },
      // One day either side: a proxy row is stamped at noon UTC of the day
      // before the morning it describes.
      measuredAt: {
        gte: new Date(
          Math.max(
            windowStart.getTime() - MS_PER_DAY,
            args.floor?.getTime() ?? 0,
          ),
        ),
        lt: new Date(dayEnd.getTime() + MS_PER_DAY),
      },
    },
    select: { type: true, value: true, measuredAt: true, source: true },
    orderBy: { measuredAt: "asc" },
  });
  const { day, tz } = args;
  const out: Partial<Record<DayScoreKey, DayScore>> = {};

  const recovery = rows.filter((r) => r.type === "RECOVERY_SCORE");
  const proxyByDay = new Map<string, number>();
  for (const row of recovery) {
    if (row.source !== "COMPUTED") continue;
    proxyByDay.set(wakeDayKeyOf(row.measuredAt, row.source, tz), row.value);
  }
  const proxy = proxyByDay.get(day);
  if (proxy !== undefined) {
    out.readiness = score(
      "readiness",
      proxy,
      SCORE_SCALE_MAX,
      "COMPUTED",
      priorValues(proxyByDay, windowFrom, day),
    );
  }

  const canonical = new Map<
    string,
    { value: number; source: MeasurementSource }
  >();
  for (const row of resolveCanonicalRecovery(recovery, tz)) {
    canonical.set(wakeDayKeyOf(row.measuredAt, row.source, tz), row);
  }
  const device = canonical.get(day);
  if (device && device.source !== "COMPUTED") {
    const deviceByDay = new Map<string, number>();
    for (const [key, row] of canonical) {
      if (row.source !== "COMPUTED") deviceByDay.set(key, row.value);
    }
    out.recovery = score(
      "recovery",
      device.value,
      SCORE_SCALE_MAX,
      device.source,
      priorValues(deviceByDay, windowFrom, day),
    );
  }

  // The proxy's day is the day it describes, stamped at noon UTC.
  const strainByDay = new Map<string, number>();
  for (const row of rows) {
    if (row.type === "STRAIN_SCORE" && row.source === "COMPUTED") {
      strainByDay.set(dateOnlyKey(row.measuredAt), row.value);
    }
  }
  const strain = strainByDay.get(day);
  if (strain !== undefined) {
    out.strain = score(
      "strain",
      strain,
      SCORE_SCALE_MAX,
      "COMPUTED",
      priorValues(strainByDay, windowFrom, day),
    );
  } else {
    const deviceRows = rows.filter((r) => r.type === "DAY_STRAIN");
    const deviceByDay = new Map<string, number>();
    for (const folded of deviceStrainDays(deviceRows, tz)) {
      deviceByDay.set(userDayKey(folded.measuredAt, tz), folded.value);
    }
    const today = deviceByDay.get(day);
    if (today !== undefined) {
      // The latest row of the day names the device.
      const source =
        deviceRows.findLast((r) => userDayKey(r.measuredAt, tz) === day)
          ?.source ?? "COMPUTED";
      out.strain = score(
        "strain",
        today,
        DEVICE_STRAIN_SCALE_MAX,
        source,
        priorValues(deviceByDay, windowFrom, day),
      );
    }
  }
  return out;
}

/** Local hour by which the night that ended this morning is over. */
const NIGHT_CUTOFF_HOURS = 18;

async function sleepScoreOf(
  args: DayScoresArgs,
  dayStart: Date,
): Promise<DayScore | null> {
  const until = new Date(dayStart.getTime() + NIGHT_CUTOFF_HOURS * 3_600_000);
  // The score reads 30 nights; under a lookback limit that does not hold
  // them, it is left out rather than computed over fewer.
  if (args.floor && until.getTime() - 30 * MS_PER_DAY < args.floor.getTime()) {
    return null;
  }
  const user = await prisma.user.findUnique({
    where: { id: args.userId },
    select: { dateOfBirth: true },
  });
  const derived = await computeSleepScore(
    args.userId,
    {
      ageYears: getAgeFromDateOfBirth(user?.dateOfBirth ?? null),
      sex: null,
    },
    { now: until, until, tz: args.tz, priorityJson: args.priorityJson },
  );
  if (derived.status !== "ok" || !derived.value) return null;
  if (derived.value.night !== args.day) return null;
  // The series ends on this night; the nights before it are the range.
  const prior = derived.value.series.slice(0, -1);
  return score(
    "sleepScore",
    derived.value.score,
    SCORE_SCALE_MAX,
    "COMPUTED",
    prior,
  );
}

async function healthScoreOf(
  args: DayScoresArgs,
  windowFrom: string,
): Promise<DayScore | null> {
  const rows = await prisma.healthScoreRecord.findMany({
    where: { userId: args.userId, dayKey: { gte: windowFrom, lte: args.day } },
    select: { dayKey: true, composite: true },
  });
  const byDay = new Map(rows.map((row) => [row.dayKey, row.composite]));
  const value = byDay.get(args.day);
  if (value === undefined) return null;
  return score(
    "healthScore",
    value,
    SCORE_SCALE_MAX,
    "COMPUTED",
    priorValues(byDay, windowFrom, args.day),
  );
}

/**
 * Every score the record holds for the day, in `DAY_SCORE_KEYS` order. A
 * score whose module is off is not read.
 */
export async function readDayScores(args: DayScoresArgs): Promise<DayScore[]> {
  const { day, tz, modules } = args;
  const { dayStart, dayEnd } = localDayWindow(day, tz);
  let windowFrom = shiftDateKey(day, -BAND_WINDOW_DAYS);
  let windowStart = startOfLocalDayKey(windowFrom, tz);
  if (args.floor && args.floor > windowStart) {
    windowStart = args.floor;
    windowFrom = userDayKey(args.floor, tz);
  }

  const wellnessOn =
    dayScoreVisible("readiness", modules) ||
    dayScoreVisible("recovery", modules) ||
    dayScoreVisible("strain", modules);
  const [wellness, sleep, health] = await Promise.all([
    wellnessOn
      ? wellnessScores(args, windowFrom, windowStart, dayEnd)
      : Promise.resolve({} as Partial<Record<DayScoreKey, DayScore>>),
    dayScoreVisible("sleepScore", modules)
      ? sleepScoreOf(args, dayStart)
      : Promise.resolve(null),
    healthScoreOf(args, windowFrom),
  ]);

  const found: Partial<Record<DayScoreKey, DayScore | null>> = {
    healthScore: health,
    sleepScore: sleep,
    ...wellness,
  };
  return DAY_SCORE_KEYS.filter((key) => dayScoreVisible(key, modules))
    .map((key) => found[key])
    .filter((entry): entry is DayScore => entry != null);
}
