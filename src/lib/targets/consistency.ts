import { shiftDateKey } from "@/lib/tz/format";
import { userDayKey } from "@/lib/tz/resolver";
import type { DayBand, TargetConsistency } from "./types";

const EMPTY_STRIP = [null, null, null, null, null, null, null] as const;

const EMPTY_CONSISTENCY: TargetConsistency = {
  daysInRange7d: 0,
  daysLogged7d: 0,
  daysInRange30d: 0,
  daysLogged30d: 0,
  lastMetGoalAt: null,
  streakDays: 0,
  insufficientData: true,
  consistency7d: EMPTY_STRIP,
};

interface ConsistencyClock {
  timezone: string;
  now: Date;
}

interface RollupConsistencyInput extends ConsistencyClock {
  events: ReadonlyArray<{ measuredAt: Date; value: number }>;
  classify: (mean: number) => DayBand | null;
  totalReadingsThreshold?: number;
}

interface RollupDayMapInput extends ConsistencyClock {
  dayBandByKey: ReadonlyMap<string, DayBand | null>;
  totalDaysThreshold?: number;
}

function dayKeyAtOffset(now: Date, timezone: string, daysAgo: number): string {
  // By calendar day, not by `now − n·24 h`: across a 23- or 25-hour day the
  // millisecond step lands on the wrong local day, which repeats one day of
  // the week and drops another.
  return shiftDateKey(userDayKey(now, timezone), -daysAgo);
}

function last7DayKeys(now: Date, timezone: string): string[] {
  const keys: string[] = [];
  for (let daysAgo = 6; daysAgo >= 0; daysAgo--) {
    keys.push(dayKeyAtOffset(now, timezone, daysAgo));
  }
  return keys;
}

/** A day's readings folded to their sum and count, keyed by local day. */
export type DaySums = ReadonlyMap<string, { sum: number; count: number }>;

function sumByDay(
  events: ReadonlyArray<{ measuredAt: Date; value: number }>,
  timezone: string,
): Map<string, { sum: number; count: number }> {
  const byDay = new Map<string, { sum: number; count: number }>();
  for (const event of events) {
    const key = userDayKey(event.measuredAt, timezone);
    const bucket = byDay.get(key) ?? { sum: 0, count: 0 };
    bucket.sum += event.value;
    bucket.count += 1;
    byDay.set(key, bucket);
  }
  return byDay;
}

function computeStrip(
  byDay: DaySums,
  classify: (mean: number) => DayBand | null,
  timezone: string,
  now: Date,
) {
  const consistency7d: Array<DayBand | null> = [];
  let daysInRange7d = 0;
  let daysLogged7d = 0;
  for (const key of last7DayKeys(now, timezone)) {
    const bucket = byDay.get(key);
    if (!bucket) {
      consistency7d.push(null);
      continue;
    }
    daysLogged7d += 1;
    const band = classify(bucket.sum / bucket.count);
    consistency7d.push(band);
    if (band === "in") daysInRange7d += 1;
  }
  return { consistency7d, daysInRange7d, daysLogged7d };
}

export function rollupConsistency({
  events,
  ...rest
}: RollupConsistencyInput): TargetConsistency {
  return rollupConsistencyFromDays({
    ...rest,
    byDay: sumByDay(events, rest.timezone),
    readingCount: events.length,
  });
}

interface RollupDaySumsInput extends ConsistencyClock {
  /** Each local day's readings as sum and count. */
  byDay: DaySums;
  /** Readings behind `byDay`, for the thin-data threshold. */
  readingCount: number;
  classify: (mean: number) => DayBand | null;
  totalReadingsThreshold?: number;
}

/**
 * The same consistency as {@link rollupConsistency}, from readings already
 * folded per local day. Every figure here is a function of each day's mean
 * and of the reading count, so a reader that folds in SQL hands over one row
 * per day instead of every reading and gets the same answer.
 */
export function rollupConsistencyFromDays({
  byDay,
  readingCount,
  classify,
  timezone,
  now,
  totalReadingsThreshold = 3,
}: RollupDaySumsInput): TargetConsistency {
  if (readingCount < totalReadingsThreshold) {
    const partial = computeStrip(byDay, classify, timezone, now);
    return {
      ...EMPTY_CONSISTENCY,
      ...partial,
      insufficientData: true,
    };
  }

  const strip = computeStrip(byDay, classify, timezone, now);

  let daysInRange30d = 0;
  let daysLogged30d = 0;
  for (let daysAgo = 29; daysAgo >= 0; daysAgo--) {
    const bucket = byDay.get(dayKeyAtOffset(now, timezone, daysAgo));
    if (!bucket) continue;
    daysLogged30d += 1;
    if (classify(bucket.sum / bucket.count) === "in") daysInRange30d += 1;
  }

  let lastMetGoalAt: string | null = null;
  for (let daysAgo = 0; daysAgo < 30; daysAgo++) {
    const key = dayKeyAtOffset(now, timezone, daysAgo);
    const bucket = byDay.get(key);
    if (!bucket) continue;
    if (classify(bucket.sum / bucket.count) === "in") {
      lastMetGoalAt = key;
      break;
    }
  }

  let streakDays = 0;
  for (let daysAgo = 0; daysAgo < 365; daysAgo++) {
    const bucket = byDay.get(dayKeyAtOffset(now, timezone, daysAgo));
    if (!bucket || classify(bucket.sum / bucket.count) !== "in") break;
    streakDays += 1;
  }

  return {
    daysInRange7d: strip.daysInRange7d,
    daysLogged7d: strip.daysLogged7d,
    daysInRange30d,
    daysLogged30d,
    lastMetGoalAt,
    streakDays,
    insufficientData:
      readingCount < totalReadingsThreshold || strip.daysLogged7d < 1,
    consistency7d: strip.consistency7d,
  };
}

export function rollupFromDayMap({
  dayBandByKey,
  timezone,
  now,
  totalDaysThreshold = 3,
}: RollupDayMapInput): TargetConsistency {
  const loggedKeys = Array.from(dayBandByKey.values()).filter(
    (band) => band !== null,
  );
  const strip = last7DayKeys(now, timezone).map(
    (key) => dayBandByKey.get(key) ?? null,
  );
  const daysLogged7d = strip.filter((band) => band !== null).length;
  const daysInRange7d = strip.filter((band) => band === "in").length;

  if (loggedKeys.length < totalDaysThreshold) {
    return {
      ...EMPTY_CONSISTENCY,
      consistency7d: strip,
      daysLogged7d,
      daysInRange7d,
      insufficientData: true,
    };
  }

  let daysInRange30d = 0;
  let daysLogged30d = 0;
  for (let daysAgo = 29; daysAgo >= 0; daysAgo--) {
    const band = dayBandByKey.get(dayKeyAtOffset(now, timezone, daysAgo));
    if (!band) continue;
    daysLogged30d += 1;
    if (band === "in") daysInRange30d += 1;
  }

  let lastMetGoalAt: string | null = null;
  for (let daysAgo = 0; daysAgo < 30; daysAgo++) {
    const key = dayKeyAtOffset(now, timezone, daysAgo);
    if (dayBandByKey.get(key) === "in") {
      lastMetGoalAt = key;
      break;
    }
  }

  let streakDays = 0;
  for (let daysAgo = 0; daysAgo < 365; daysAgo++) {
    const band = dayBandByKey.get(dayKeyAtOffset(now, timezone, daysAgo));
    if (band === undefined || band === null || band !== "in") break;
    streakDays += 1;
  }

  return {
    daysInRange7d,
    daysLogged7d,
    daysInRange30d,
    daysLogged30d,
    lastMetGoalAt,
    streakDays,
    insufficientData: loggedKeys.length < totalDaysThreshold,
    consistency7d: strip,
  };
}

export function makeRangeClassifier(
  range: { min: number; max: number } | null,
  options?: { orangeMin?: number; orangeMax?: number },
): (mean: number) => DayBand | null {
  if (!range) return () => null;
  const span = range.max - range.min;
  const orangeMin = options?.orangeMin ?? range.min - span * 0.3;
  const orangeMax = options?.orangeMax ?? range.max + span * 0.3;
  return (mean) => {
    if (mean >= range.min && mean <= range.max) return "in";
    if (mean >= orangeMin && mean <= orangeMax) return "near";
    return "out";
  };
}
