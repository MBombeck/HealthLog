import { prisma } from "@/lib/db";
import { apiSuccess } from "@/lib/api-response";
import {
  classifyBMI,
  classifyBP,
  classifySleepDuration,
  classifyBodyFat,
  classifySteps,
  getWeightRange,
  getSleepDurationRange,
  getStepsRange,
  getBpTargetsByAge,
} from "@/lib/analytics/classifications";
import { calculateCompliance } from "@/lib/analytics/compliance";
import { pairByTimestamp } from "@/lib/analytics/correlations";
import { isBpReadingInTarget } from "@/lib/analytics/bp-in-target";
import { userDayKey, DEFAULT_TIMEZONE } from "@/lib/tz/resolver";
import {
  classifyPulseByTarget,
  getPersonalizedPulseTarget,
} from "@/lib/analytics/pulse-targets";
import type {
  MeasurementType,
  GlucoseContext,
} from "@/generated/prisma/client";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import {
  getEffectiveRange,
  type ThresholdOverridesJson,
} from "@/lib/analytics/effective-range";
import { getBodyFatTargetRange } from "@/lib/analytics/value-bands";
import { thresholdMetricForContext, resolveGlucoseUnit } from "@/lib/glucose";

export const dynamic = "force-dynamic";

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

interface TargetItem {
  type: string;
  label: string;
  current: number | null;
  average30: number | null;
  trend: "up" | "down" | "stable" | null;
  unit: string;
  range: { min: number; max: number } | null;
  classification: { category: string; color: string } | null;
  source: string;
  /**
   * v1.4.25 W3e — consistency strip support. Berlin-tz day buckets over
   * the last 7 days. `daysInRange7d` is the count of days whose mean
   * reading landed inside the target's green band; `daysLogged7d` is
   * how many of those days had at least one reading (so the strip can
   * render filled / hollow / dimmed dots without ambiguity).
   *
   * `lastMetGoalAt` is the most recent Berlin-tz day whose mean reading
   * was in the green band (ISO date YYYY-MM-DD), or null if the user
   * has not hit goal in the last 30 days.
   *
   * `streakDays` is the count of consecutive Berlin days ending today
   * where the day's mean was in the green band. Capped at 365.
   *
   * `insufficientData` is true when the target has fewer than 3
   * readings over the last 30 days OR fewer than 1 day of data in the
   * last 7 days. The page hides the strip + percentage when this is
   * true.
   */
  daysInRange7d: number;
  daysLogged7d: number;
  daysInRange30d: number;
  daysLogged30d: number;
  lastMetGoalAt: string | null;
  streakDays: number;
  insufficientData: boolean;
  /**
   * v1.4.25 W3e — per-day classification of the last 7 Berlin-tz days
   * for the consistency strip. Index 0 is six days ago, index 6 is
   * today. `null` slots represent days with no readings; non-null
   * slots represent days whose mean reading landed in the named band.
   */
  consistency7d: ReadonlyArray<"in" | "near" | "out" | null>;
  details?: {
    medications?: Array<{
      name: string;
      compliance7: number;
      compliance30: number;
    }>;
  };
}

interface TargetPageSummary {
  targetsMetThisWeek: number;
  totalTargets: number;
  streakHighlight: { metric: string; days: number } | null;
}

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();

  const userId = user.id;

  // v1.4.25 W7b — every per-day bucket key in this route resolves
  // against the user's display timezone so a Pacific/Auckland user gets
  // their Auckland-day streaks, their Auckland-day "last met goal" date,
  // and their Auckland-day consistency strip. Falls back to
  // Europe/Berlin when the column is somehow missing (defensive — the
  // schema's NOT NULL default normally pins it).
  const userTz = user.timezone ?? DEFAULT_TIMEZONE;
  const dayKey = (d: Date): string => userDayKey(d, userTz);

  // Fetch user profile
  const dbUser = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      heightCm: true,
      dateOfBirth: true,
      gender: true,
      glucoseUnit: true,
      thresholdsJson: true,
    },
  });

  const age = dbUser?.dateOfBirth ? getAge(new Date(dbUser.dateOfBirth)) : null;
  const gender = (dbUser?.gender as "MALE" | "FEMALE" | null) ?? null;
  const heightCm = dbUser?.heightCm ?? null;

  // Fetch latest measurements for each type
  const types: MeasurementType[] = [
    "WEIGHT",
    "BLOOD_PRESSURE_SYS",
    "BLOOD_PRESSURE_DIA",
    "PULSE",
    "SLEEP_DURATION",
    "BODY_FAT",
    "ACTIVITY_STEPS",
  ];

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  // Fetch all measurements in the last 30 days + the latest for each type
  const recentMeasurements = await prisma.measurement.findMany({
    where: {
      userId,
      type: { in: types },
      measuredAt: { gte: thirtyDaysAgo },
    },
    orderBy: { measuredAt: "desc" },
    select: { type: true, value: true, measuredAt: true },
  });

  // Also get the absolute latest measurement per type (even if older than 30 days).
  // Single grouped query replaces the previous N×findFirst loop — DISTINCT ON
  // (Postgres) emulated via a windowed orderBy + take-1 per type would still be
  // N round-trips, so we sort once on the wide query and pick per-type below.
  const latestEverByType = await prisma.measurement.findMany({
    where: { userId, type: { in: types } },
    orderBy: { measuredAt: "desc" },
    distinct: ["type"],
    select: { type: true, value: true },
  });

  const latestByType: Record<string, number | null> = {};
  const avg30ByType: Record<string, number | null> = {};

  for (const t of types) {
    const latest = latestEverByType.find((row) => row.type === t);
    latestByType[t] = latest?.value ?? null;

    const recentOfType = recentMeasurements.filter((m) => m.type === t);
    if (recentOfType.length > 0) {
      const sum = recentOfType.reduce((acc, m) => acc + m.value, 0);
      avg30ByType[t] = Math.round((sum / recentOfType.length) * 10) / 10;
    } else {
      avg30ByType[t] = null;
    }
  }

  // Compute trend (compare first half of 30-day data to second half)
  function computeTrend(
    type: MeasurementType,
  ): "up" | "down" | "stable" | null {
    const data = recentMeasurements
      .filter((m) => m.type === type)
      .sort((a, b) => a.measuredAt.getTime() - b.measuredAt.getTime());
    if (data.length < 4) return null;

    const mid = Math.floor(data.length / 2);
    const firstHalf = data.slice(0, mid);
    const secondHalf = data.slice(mid);

    const avgFirst =
      firstHalf.reduce((s, m) => s + m.value, 0) / firstHalf.length;
    const avgSecond =
      secondHalf.reduce((s, m) => s + m.value, 0) / secondHalf.length;

    const diff = avgSecond - avgFirst;
    const threshold = avgFirst * 0.02; // 2% change threshold

    if (diff > threshold) return "up";
    if (diff < -threshold) return "down";
    return "stable";
  }

  // --------------------------------------------------------------------
  // v1.4.25 W3e — consistency helper. Buckets readings by Berlin-tz day
  // and classifies each day's mean against the target's green band.
  // Single helper shared by every target type so the rule stays stable
  // (mean reading per day → in-range / near-range / out-of-range).
  // --------------------------------------------------------------------
  const last7DayKeys: string[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    last7DayKeys.push(dayKey(d));
  }

  type DayBand = "in" | "near" | "out";

  interface ConsistencyOutput {
    daysInRange7d: number;
    daysLogged7d: number;
    daysInRange30d: number;
    daysLogged30d: number;
    lastMetGoalAt: string | null;
    streakDays: number;
    insufficientData: boolean;
    consistency7d: ReadonlyArray<DayBand | null>;
  }

  const EMPTY_CONSISTENCY: ConsistencyOutput = {
    daysInRange7d: 0,
    daysLogged7d: 0,
    daysInRange30d: 0,
    daysLogged30d: 0,
    lastMetGoalAt: null,
    streakDays: 0,
    insufficientData: true,
    consistency7d: [null, null, null, null, null, null, null] as const,
  };

  /**
   * Bucket a series of `{ measuredAt, value }` events by Berlin-tz day,
   * classify each day's mean against the target band, and roll up the
   * 7-day strip + 30-day stats + recency + streak.
   *
   * `classify(meanValue)` returns the band the day's mean falls into.
   * Pass `null` to mean "no band — skip this day for classification".
   */
  function rollupConsistency(
    events: ReadonlyArray<{ measuredAt: Date; value: number }>,
    classify: (mean: number) => DayBand | null,
    totalReadingsThreshold = 3,
  ): ConsistencyOutput {
    if (events.length < totalReadingsThreshold) {
      // Cold-start path. Still emit the per-day strip if we have any
      // recent readings, but mark insufficient so the UI hides the %.
      const partial = computeStrip(events, classify);
      return {
        ...EMPTY_CONSISTENCY,
        consistency7d: partial.consistency7d,
        daysLogged7d: partial.daysLogged7d,
        daysInRange7d: partial.daysInRange7d,
        insufficientData: true,
      };
    }

    const byDay = new Map<string, { sum: number; count: number }>();
    for (const ev of events) {
      const day = dayKey(ev.measuredAt);
      const bucket = byDay.get(day) ?? { sum: 0, count: 0 };
      bucket.sum += ev.value;
      bucket.count += 1;
      byDay.set(day, bucket);
    }

    const stripPart = computeStrip(events, classify);

    // 30-day stats: walk the last 30 Berlin-tz day keys.
    let daysInRange30d = 0;
    let daysLogged30d = 0;
    for (let i = 29; i >= 0; i--) {
      const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
      const key = dayKey(d);
      const bucket = byDay.get(key);
      if (!bucket) continue;
      daysLogged30d += 1;
      const mean = bucket.sum / bucket.count;
      if (classify(mean) === "in") daysInRange30d += 1;
    }

    // lastMetGoalAt: walk back from today until a day is in range.
    let lastMetGoalAt: string | null = null;
    for (let i = 0; i < 30; i++) {
      const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
      const key = dayKey(d);
      const bucket = byDay.get(key);
      if (!bucket) continue;
      const mean = bucket.sum / bucket.count;
      if (classify(mean) === "in") {
        lastMetGoalAt = key;
        break;
      }
    }

    // streakDays: consecutive days ending today that are in-range. A
    // day with no reading breaks the streak (the user did not meet the
    // goal that day, even if today is in-range).
    let streakDays = 0;
    for (let i = 0; i < 365; i++) {
      const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
      const key = dayKey(d);
      const bucket = byDay.get(key);
      if (!bucket) break;
      const mean = bucket.sum / bucket.count;
      if (classify(mean) !== "in") break;
      streakDays += 1;
    }

    // insufficientData: < 3 readings total OR < 1 day in the last 7.
    const insufficientData =
      events.length < totalReadingsThreshold || stripPart.daysLogged7d < 1;

    return {
      daysInRange7d: stripPart.daysInRange7d,
      daysLogged7d: stripPart.daysLogged7d,
      daysInRange30d,
      daysLogged30d,
      lastMetGoalAt,
      streakDays,
      insufficientData,
      consistency7d: stripPart.consistency7d,
    };
  }

  function computeStrip(
    events: ReadonlyArray<{ measuredAt: Date; value: number }>,
    classify: (mean: number) => DayBand | null,
  ): {
    consistency7d: ReadonlyArray<DayBand | null>;
    daysInRange7d: number;
    daysLogged7d: number;
  } {
    const byDay = new Map<string, { sum: number; count: number }>();
    for (const ev of events) {
      const day = dayKey(ev.measuredAt);
      const bucket = byDay.get(day) ?? { sum: 0, count: 0 };
      bucket.sum += ev.value;
      bucket.count += 1;
      byDay.set(day, bucket);
    }
    const strip: Array<DayBand | null> = [];
    let daysInRange7d = 0;
    let daysLogged7d = 0;
    for (const key of last7DayKeys) {
      const bucket = byDay.get(key);
      if (!bucket) {
        strip.push(null);
        continue;
      }
      daysLogged7d += 1;
      const mean = bucket.sum / bucket.count;
      const band = classify(mean);
      strip.push(band);
      if (band === "in") daysInRange7d += 1;
    }
    return { consistency7d: strip, daysInRange7d, daysLogged7d };
  }

  /**
   * Helper: classify a value against a target range with an orange band
   * symmetrical to the green band (the same heuristic RangeBar uses
   * client-side). When `min`/`max` is null we treat the input as
   * unclassifiable and return null.
   */
  function makeRangeClassifier(
    range: { min: number; max: number } | null,
    options?: { orangeMin?: number; orangeMax?: number },
  ): (mean: number) => DayBand | null {
    if (!range) return () => null;
    const span = range.max - range.min;
    const orangeMin = options?.orangeMin ?? range.min - span * 0.3;
    const orangeMax = options?.orangeMax ?? range.max + span * 0.3;
    return (mean: number) => {
      if (mean >= range.min && mean <= range.max) return "in";
      if (mean >= orangeMin && mean <= orangeMax) return "near";
      return "out";
    };
  }

  /**
   * Per-day BP-in-target classifier: a day is "in" if every BP pair on
   * that day (sys+dia matched within 5 min) passes `isBpReadingInTarget`.
   * "near" if at least one pair passes; "out" otherwise.
   *
   * Returns a function (day-key, dayEvents) → band. We pre-compute the
   * by-day map once because the route already paginates BP twice (sys
   * + dia) and we want to avoid quadratic work.
   */
  function buildBpPairsByDay(): Map<string, DayBand | null> {
    if (!bpRange) return new Map();
    const sysByDay = new Map<string, Array<{ date: Date; value: number }>>();
    const diaByDay = new Map<string, Array<{ date: Date; value: number }>>();
    for (const m of recentMeasurements) {
      if (m.type === "BLOOD_PRESSURE_SYS") {
        const k = dayKey(m.measuredAt);
        const arr = sysByDay.get(k) ?? [];
        arr.push({ date: m.measuredAt, value: m.value });
        sysByDay.set(k, arr);
      } else if (m.type === "BLOOD_PRESSURE_DIA") {
        const k = dayKey(m.measuredAt);
        const arr = diaByDay.get(k) ?? [];
        arr.push({ date: m.measuredAt, value: m.value });
        diaByDay.set(k, arr);
      }
    }
    const out = new Map<string, DayBand | null>();
    const allKeys = new Set([...sysByDay.keys(), ...diaByDay.keys()]);
    for (const key of allKeys) {
      const sys = sysByDay.get(key) ?? [];
      const dia = diaByDay.get(key) ?? [];
      const pairs = pairByTimestamp(sys, dia, 5 * 60 * 1000);
      if (pairs.length === 0) {
        out.set(key, null);
        continue;
      }
      const inCount = pairs.filter((p) =>
        isBpReadingInTarget(p.a, p.b, bpRange),
      ).length;
      if (inCount === pairs.length) out.set(key, "in");
      else if (inCount > 0) out.set(key, "near");
      else out.set(key, "out");
    }
    return out;
  }

  // We need bpRange before the per-target loop runs so the helpers above
  // can use it; reorder the local so it's available.
  const bpRange = age != null ? getBpTargetsByAge(age, gender) : null;

  /**
   * Roll up consistency for a target whose bands come from a pre-mapped
   * `dayBandByKey` map (used for BP-in-target and medication compliance
   * which have day-level classification rather than mean-classification).
   */
  function rollupFromDayMap(
    dayBandByKey: Map<string, DayBand | null>,
    totalDaysThreshold = 3,
  ): ConsistencyOutput {
    const loggedKeys = Array.from(dayBandByKey.entries()).filter(
      ([, v]) => v !== null,
    );
    if (loggedKeys.length < totalDaysThreshold) {
      // Cold-start: still emit the strip.
      const strip: Array<DayBand | null> = last7DayKeys.map(
        (k) => dayBandByKey.get(k) ?? null,
      );
      const daysLogged7d = strip.filter((b) => b !== null).length;
      const daysInRange7d = strip.filter((b) => b === "in").length;
      return {
        ...EMPTY_CONSISTENCY,
        consistency7d: strip,
        daysLogged7d,
        daysInRange7d,
        insufficientData: true,
      };
    }

    const strip: Array<DayBand | null> = last7DayKeys.map(
      (k) => dayBandByKey.get(k) ?? null,
    );
    const daysLogged7d = strip.filter((b) => b !== null).length;
    const daysInRange7d = strip.filter((b) => b === "in").length;

    let daysInRange30d = 0;
    let daysLogged30d = 0;
    for (let i = 29; i >= 0; i--) {
      const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
      const key = dayKey(d);
      const band = dayBandByKey.get(key);
      if (!band) continue;
      daysLogged30d += 1;
      if (band === "in") daysInRange30d += 1;
    }

    let lastMetGoalAt: string | null = null;
    for (let i = 0; i < 30; i++) {
      const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
      const key = dayKey(d);
      if (dayBandByKey.get(key) === "in") {
        lastMetGoalAt = key;
        break;
      }
    }

    let streakDays = 0;
    for (let i = 0; i < 365; i++) {
      const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
      const key = dayKey(d);
      const band = dayBandByKey.get(key);
      if (band === undefined || band === null) break;
      if (band !== "in") break;
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

  // Memo: pre-compute the BP-pairs day map once.
  const bpPairsByDay = buildBpPairsByDay();

  // Build target items
  const targets: TargetItem[] = [];

  // 1. Weight
  const weightRange = heightCm ? getWeightRange(heightCm) : null;
  let weightClassification: { category: string; color: string } | null = null;
  if (latestByType.WEIGHT != null && heightCm) {
    const heightM = heightCm / 100;
    const bmi = latestByType.WEIGHT / (heightM * heightM);
    const cls = classifyBMI(bmi);
    weightClassification = { category: cls.category, color: cls.color };
  }
  {
    const consistency = rollupConsistency(
      recentMeasurements.filter((m) => m.type === "WEIGHT"),
      makeRangeClassifier(weightRange),
    );
    targets.push({
      type: "WEIGHT",
      label: "Weight",
      current: latestByType.WEIGHT ?? null,
      average30: avg30ByType.WEIGHT ?? null,
      trend: computeTrend("WEIGHT"),
      unit: "kg",
      range: weightRange,
      classification: weightClassification,
      source: "WHO BMI",
      ...consistency,
    });
  }

  // 2. Blood Pressure (sys/dia combined)
  // `bpRange` is hoisted to the helpers block above so the BP-pairs
  // day-map can use it; do not redeclare here.
  let bpClassification: { category: string; color: string } | null = null;
  if (
    latestByType.BLOOD_PRESSURE_SYS != null &&
    latestByType.BLOOD_PRESSURE_DIA != null
  ) {
    const cls = classifyBP(
      latestByType.BLOOD_PRESSURE_SYS,
      latestByType.BLOOD_PRESSURE_DIA,
    );
    bpClassification = { category: cls.category, color: cls.color };
  }
  {
    // Per-day BP classifier reuses the sys+dia paired classifier from
    // `bpPairsByDay`. This is the right semantic for "in target band"
    // because a systolic in range with a diastolic out of range is
    // still an out-of-target reading.
    const consistency = rollupFromDayMap(bpPairsByDay);
    targets.push({
      type: "BLOOD_PRESSURE",
      label: "Blood pressure",
      current: latestByType.BLOOD_PRESSURE_SYS ?? null,
      average30: avg30ByType.BLOOD_PRESSURE_SYS ?? null,
      trend: computeTrend("BLOOD_PRESSURE_SYS"),
      unit: "mmHg",
      range: bpRange ? { min: bpRange.sysLow, max: bpRange.sysHigh } : null,
      classification: bpClassification,
      source: "ESH 2023",
      ...consistency,
      // Extra fields for diastolic
    } as TargetItem);
  }

  // 2b. Blood pressure target-hit rate over 30 days
  if (bpRange) {
    const sysPoints = recentMeasurements
      .filter((measurement) => measurement.type === "BLOOD_PRESSURE_SYS")
      .map((measurement) => ({
        date: measurement.measuredAt,
        value: measurement.value,
      }));
    const diaPoints = recentMeasurements
      .filter((measurement) => measurement.type === "BLOOD_PRESSURE_DIA")
      .map((measurement) => ({
        date: measurement.measuredAt,
        value: measurement.value,
      }));

    const bpPairs = pairByTimestamp(sysPoints, diaPoints, 5 * 60 * 1000);
    // v1.4.16 A2 — one-sided ceiling semantics with hypotension
    // floor. See lib/analytics/bp-in-target.ts.
    const bpInTargetCount = bpPairs.filter((pair) =>
      isBpReadingInTarget(pair.a, pair.b, bpRange),
    ).length;
    const bpInTargetRate =
      bpPairs.length > 0
        ? Math.round((bpInTargetCount / bpPairs.length) * 100 * 10) / 10
        : null;

    // BP-in-target consistency mirrors the BP pair-by-day map above:
    // a day is "in" when every pair on that day clears the BP target.
    const inTargetConsistency = rollupFromDayMap(bpPairsByDay);
    targets.push({
      type: "BLOOD_PRESSURE_IN_TARGET",
      label: "Blood pressure on target",
      current: bpInTargetRate,
      average30: bpInTargetRate,
      trend: null,
      unit: "%",
      range: { min: 70, max: 100 },
      classification:
        bpInTargetRate != null
          ? bpInTargetRate >= 70
            ? { category: "Good", color: "#50fa7b" }
            : bpInTargetRate >= 40
              ? { category: "Moderate", color: "#f1fa8c" }
              : { category: "Low", color: "#ff5555" }
          : null,
      source: "ESH 2023",
      ...inTargetConsistency,
    });
  }

  // 3. Pulse
  const pulseTarget = getPersonalizedPulseTarget(age, gender);
  let pulseClassification: { category: string; color: string } | null = null;
  if (latestByType.PULSE != null) {
    const cls = classifyPulseByTarget(latestByType.PULSE, pulseTarget);
    pulseClassification = { category: cls.category, color: cls.color };
  }
  {
    const pulseRange = {
      min: pulseTarget.greenMin,
      max: pulseTarget.greenMax,
    };
    const consistency = rollupConsistency(
      recentMeasurements.filter((m) => m.type === "PULSE"),
      makeRangeClassifier(pulseRange, {
        orangeMin: pulseTarget.orangeMin,
        orangeMax: pulseTarget.orangeMax,
      }),
    );
    targets.push({
      type: "PULSE",
      label: "Resting pulse",
      current: latestByType.PULSE ?? null,
      average30: avg30ByType.PULSE ?? null,
      trend: computeTrend("PULSE"),
      unit: "bpm",
      range: pulseRange,
      classification: pulseClassification,
      source: pulseTarget.source,
      ...consistency,
    });
  }

  // 4. Sleep Duration
  const sleepRange = getSleepDurationRange();
  let sleepClassification: { category: string; color: string } | null = null;
  if (latestByType.SLEEP_DURATION != null) {
    const cls = classifySleepDuration(latestByType.SLEEP_DURATION);
    sleepClassification = { category: cls.category, color: cls.color };
  }
  {
    const consistency = rollupConsistency(
      recentMeasurements.filter((m) => m.type === "SLEEP_DURATION"),
      makeRangeClassifier(sleepRange),
    );
    targets.push({
      type: "SLEEP_DURATION",
      label: "Sleep duration",
      current: latestByType.SLEEP_DURATION ?? null,
      average30: avg30ByType.SLEEP_DURATION ?? null,
      trend: computeTrend("SLEEP_DURATION"),
      unit: "h",
      range: sleepRange,
      classification: sleepClassification,
      source: "AASM/SRS",
      ...consistency,
    });
  }

  // 5. BMI (derived from weight + height)
  if (heightCm) {
    const heightM = heightCm / 100;
    const heightSq = heightM * heightM;
    const latestWeight = latestByType.WEIGHT ?? null;
    const currentBmi =
      latestWeight != null
        ? Math.round((latestWeight / heightSq) * 10) / 10
        : null;

    // Compute 30-day average BMI from average weight
    const avgWeight = avg30ByType.WEIGHT ?? null;
    const avgBmi =
      avgWeight != null ? Math.round((avgWeight / heightSq) * 10) / 10 : null;

    let bmiClassification: { category: string; color: string } | null = null;
    if (currentBmi != null) {
      const cls = classifyBMI(currentBmi);
      bmiClassification = { category: cls.category, color: cls.color };
    }

    // BMI consistency derives from the weight series: divide each
    // bucket by height\u00B2 so the day's mean BMI is classified against
    // the BMI range bar (18.5 \u2014 24.9).
    const bmiRange = { min: 18.5, max: 24.9 };
    const bmiEvents = recentMeasurements
      .filter((m) => m.type === "WEIGHT")
      .map((m) => ({ measuredAt: m.measuredAt, value: m.value / heightSq }));
    const consistency = rollupConsistency(
      bmiEvents,
      makeRangeClassifier(bmiRange),
    );
    targets.push({
      type: "BMI",
      label: "BMI",
      current: currentBmi,
      average30: avgBmi,
      trend: computeTrend("WEIGHT"), // BMI trend follows weight trend
      unit: "kg/m\u00B2",
      range: bmiRange,
      classification: bmiClassification,
      source: "WHO",
      ...consistency,
    });
  }

  // 6. Body Fat
  let bodyFatClassification: { category: string; color: string } | null = null;
  if (latestByType.BODY_FAT != null && age != null) {
    const cls = classifyBodyFat(latestByType.BODY_FAT, gender, age);
    bodyFatClassification = { category: cls.category, color: cls.color };
  }
  // Single source of truth for the body-fat green band lives in
  // `value-bands.ts`. v1.3.3 had three different hardcoded ranges across
  // value-bands.ts / targets/route.ts / classifications.ts; the v1.4
  // marathon consolidated them onto `getBodyFatTargetRange` (ACE
  // fitness + acceptable bands).
  const bodyFatRange = age != null ? getBodyFatTargetRange(gender) : null;
  {
    const consistency = rollupConsistency(
      recentMeasurements.filter((m) => m.type === "BODY_FAT"),
      makeRangeClassifier(bodyFatRange),
    );
    targets.push({
      type: "BODY_FAT",
      label: "Body fat",
      current: latestByType.BODY_FAT ?? null,
      average30: avg30ByType.BODY_FAT ?? null,
      trend: computeTrend("BODY_FAT"),
      unit: "%",
      range: bodyFatRange,
      classification: bodyFatClassification,
      source: "ACE",
      ...consistency,
    });
  }

  // 7. Activity Steps
  const stepsRange = getStepsRange();
  let stepsClassification: { category: string; color: string } | null = null;
  if (avg30ByType.ACTIVITY_STEPS != null) {
    const cls = classifySteps(avg30ByType.ACTIVITY_STEPS);
    stepsClassification = { category: cls.category, color: cls.color };
  }
  {
    const consistency = rollupConsistency(
      recentMeasurements.filter((m) => m.type === "ACTIVITY_STEPS"),
      makeRangeClassifier(stepsRange),
    );
    targets.push({
      type: "ACTIVITY_STEPS",
      label: "Steps/day",
      current: latestByType.ACTIVITY_STEPS ?? null,
      average30: avg30ByType.ACTIVITY_STEPS ?? null,
      trend: computeTrend("ACTIVITY_STEPS"),
      unit: "steps",
      range: stepsRange,
      classification: stepsClassification,
      // WHO publishes activity *time* (150–300 min/wk moderate),
      // not a step quota. The closest peer-reviewed dose-response
      // for the 8 000–15 000 band is Saint-Maurice JAMA 2020. The
      // AI prompts at src/lib/ai/prompts/base-system.ts and
      // src/lib/ai/prompts/general-status.ts already enforce this
      // attribution; this surface label was the last "WHO" mislabel
      // in the codebase.
      source: "Saint-Maurice JAMA 2020",
      ...consistency,
    });
  }

  // 8. Medication Compliance (average across active medications)
  const activeMedications = await prisma.medication.findMany({
    where: { userId, active: true },
    include: { schedules: true },
    orderBy: { name: "asc" },
  });

  if (activeMedications.length > 0) {
    const thirtyDaysAgoIntake = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const intakeEvents = await prisma.medicationIntakeEvent.findMany({
      where: {
        userId,
        medicationId: {
          in: activeMedications.map((medication) => medication.id),
        },
        scheduledFor: { gte: thirtyDaysAgoIntake },
      },
      orderBy: { scheduledFor: "desc" },
      select: {
        medicationId: true,
        takenAt: true,
        skipped: true,
        scheduledFor: true,
      },
    });

    const medicationStats = activeMedications.map((medication) => {
      const medicationEvents = intakeEvents.filter(
        (event) => event.medicationId === medication.id,
      );
      const compliance7 = calculateCompliance(
        medicationEvents,
        medication.schedules,
        7,
        medication.createdAt,
      );
      const compliance30 = calculateCompliance(
        medicationEvents,
        medication.schedules,
        30,
        medication.createdAt,
      );

      return {
        name: medication.name,
        compliance7: compliance7.rate,
        compliance30: compliance30.rate,
        totalExpected7: compliance7.totalExpected,
        taken7: compliance7.taken,
        totalExpected30: compliance30.totalExpected,
        taken30: compliance30.taken,
      };
    });

    const totalExpected7 = medicationStats.reduce(
      (sum, medication) => sum + medication.totalExpected7,
      0,
    );
    const totalTaken7 = medicationStats.reduce(
      (sum, medication) => sum + medication.taken7,
      0,
    );
    const totalExpected30 = medicationStats.reduce(
      (sum, medication) => sum + medication.totalExpected30,
      0,
    );
    const totalTaken30 = medicationStats.reduce(
      (sum, medication) => sum + medication.taken30,
      0,
    );

    const complianceRate7 =
      totalExpected7 > 0
        ? Math.round(
            (Math.min(1, totalTaken7 / totalExpected7) * 100 + Number.EPSILON) *
              10,
          ) / 10
        : null;
    const complianceRate30 =
      totalExpected30 > 0
        ? Math.round(
            (Math.min(1, totalTaken30 / totalExpected30) * 100 +
              Number.EPSILON) *
              10,
          ) / 10
        : complianceRate7;

    // Per-day compliance: for each Berlin-tz day, classify as "in" if
    // every scheduled dose that day was taken; "near" if at least one
    // was taken; "out" if all were skipped/missed; null if there were
    // no scheduled doses (the user's regimen excluded that day).
    const dayCountsByKey = new Map<
      string,
      { taken: number; expected: number }
    >();
    for (const event of intakeEvents) {
      const key = dayKey(event.scheduledFor);
      const cur = dayCountsByKey.get(key) ?? { taken: 0, expected: 0 };
      cur.expected += 1;
      if (event.takenAt && !event.skipped) cur.taken += 1;
      dayCountsByKey.set(key, cur);
    }
    const dayBandByKey = new Map<string, DayBand | null>();
    for (const [key, counts] of dayCountsByKey.entries()) {
      if (counts.expected === 0) {
        dayBandByKey.set(key, null);
        continue;
      }
      const ratio = counts.taken / counts.expected;
      if (ratio >= 0.99) dayBandByKey.set(key, "in");
      else if (ratio >= 0.5) dayBandByKey.set(key, "near");
      else dayBandByKey.set(key, "out");
    }
    const consistency = rollupFromDayMap(dayBandByKey);
    targets.push({
      type: "MEDICATION_COMPLIANCE",
      label: "Medication compliance",
      current: complianceRate7,
      average30: complianceRate30,
      trend: null,
      unit: "%",
      range: { min: 90, max: 100 },
      classification:
        complianceRate7 != null
          ? complianceRate7 >= 90
            ? { category: "Very good", color: "#50fa7b" }
            : complianceRate7 >= 70
              ? { category: "Good", color: "#f1fa8c" }
              : { category: "Low", color: "#ff5555" }
          : null,
      source: "7-day",
      details: {
        medications: medicationStats.map((medication) => ({
          name: medication.name,
          compliance7: medication.compliance7,
          compliance30: medication.compliance30,
        })),
      },
      ...consistency,
    });
  }

  // 9. Mood targets (if mood data exists)
  const moodEntries = await prisma.moodEntry.findMany({
    where: { userId },
    orderBy: { moodLoggedAt: "desc" },
    select: { score: true, moodLoggedAt: true },
  });

  if (moodEntries.length >= 3) {
    const thirtyDaysAgoMood = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const recentMood = moodEntries.filter(
      (entry) => entry.moodLoggedAt >= thirtyDaysAgoMood,
    );
    const latestMoodScore = moodEntries[0]?.score ?? null;

    const moodAvg30 =
      recentMood.length > 0
        ? Math.round(
            (recentMood.reduce((sum, e) => sum + e.score, 0) /
              recentMood.length) *
              10,
          ) / 10
        : null;

    // Mood trend: compare first half to second half of last 30 days
    let moodTrend: "up" | "down" | "stable" | null = null;
    if (recentMood.length >= 4) {
      const sorted = [...recentMood].sort(
        (a, b) => a.moodLoggedAt.getTime() - b.moodLoggedAt.getTime(),
      );
      const mid = Math.floor(sorted.length / 2);
      const firstHalf = sorted.slice(0, mid);
      const secondHalf = sorted.slice(mid);
      const avgFirst =
        firstHalf.reduce((s, e) => s + e.score, 0) / firstHalf.length;
      const avgSecond =
        secondHalf.reduce((s, e) => s + e.score, 0) / secondHalf.length;
      const diff = avgSecond - avgFirst;
      if (diff > 0.2) moodTrend = "up";
      else if (diff < -0.2) moodTrend = "down";
      else moodTrend = "stable";
    }

    const moodClassification =
      latestMoodScore != null
        ? latestMoodScore >= 3.5
          ? { category: "Good", color: "#50fa7b" }
          : latestMoodScore >= 2
            ? { category: "Moderate", color: "#f1fa8c" }
            : { category: "Low", color: "#ff5555" }
        : null;

    const moodRange = { min: 3.5, max: 5 };
    const moodEventsForConsistency = recentMood.map((entry) => ({
      measuredAt: entry.moodLoggedAt,
      value: entry.score,
    }));
    const moodConsistency = rollupConsistency(
      moodEventsForConsistency,
      makeRangeClassifier(moodRange, { orangeMin: 2, orangeMax: 5 }),
    );
    targets.push({
      type: "MOOD_SCORE",
      label: "Mood",
      current: latestMoodScore,
      average30: moodAvg30,
      trend: moodTrend,
      unit: "/ 5",
      range: moodRange,
      classification: moodClassification,
      source: "moodLog",
      ...moodConsistency,
    });

    // Mood stability: standard deviation of recent scores (lower = more stable)
    if (recentMood.length >= 5) {
      const mean = moodAvg30 ?? latestMoodScore ?? 3;
      const variance =
        recentMood.reduce((sum, e) => sum + (e.score - mean) ** 2, 0) /
        recentMood.length;
      const stdDev = Math.round(Math.sqrt(variance) * 100) / 100;

      const stabilityClassification =
        stdDev <= 0.5
          ? { category: "Very stable", color: "#50fa7b" }
          : stdDev <= 1.0
            ? { category: "Stable", color: "#f1fa8c" }
            : { category: "Fluctuating", color: "#ff5555" };

      // Mood stability is computed from the same recent-mood window;
      // consistency mirrors MOOD_SCORE so the strip aligns with the
      // user's logging cadence rather than introducing a synthetic
      // "\u03C3 in range per day" rule that would be hard to reason about.
      targets.push({
        type: "MOOD_STABILITY",
        label: "Mood stability",
        current: stdDev,
        average30: stdDev,
        trend: null,
        unit: "\u03C3",
        range: { min: 0, max: 0.5 },
        classification: stabilityClassification,
        source: "moodLog",
        ...moodConsistency,
      });
    }
  }

  // 10. Blood glucose — one card per logged context.
  const glucoseContexts: GlucoseContext[] = [
    "FASTING",
    "POSTPRANDIAL",
    "RANDOM",
    "BEDTIME",
  ];
  const glucoseUnit = resolveGlucoseUnit(dbUser?.glucoseUnit ?? null);
  const overrides = (dbUser?.thresholdsJson ??
    null) as ThresholdOverridesJson | null;
  const profileForRange = {
    heightCm,
    dateOfBirth: dbUser?.dateOfBirth ?? null,
    gender: dbUser?.gender ?? null,
  };
  const thirtyDaysAgoGlucose = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const glucoseRows = await prisma.measurement.findMany({
    where: { userId, type: "BLOOD_GLUCOSE" },
    orderBy: { measuredAt: "desc" },
    select: { value: true, measuredAt: true, glucoseContext: true },
  });

  const labelKeyByContext: Record<GlucoseContext, string> = {
    FASTING: "targets.glucoseFasting",
    POSTPRANDIAL: "targets.glucosePostprandial",
    RANDOM: "targets.glucoseRandom",
    BEDTIME: "targets.glucoseBedtime",
  };

  for (const ctx of glucoseContexts) {
    const ctxRows = glucoseRows.filter((r) => r.glucoseContext === ctx);
    if (ctxRows.length === 0) continue;
    const latest = ctxRows[0].value;
    const recent = ctxRows.filter((r) => r.measuredAt >= thirtyDaysAgoGlucose);
    const avg30 =
      recent.length > 0
        ? Math.round(
            (recent.reduce((s, r) => s + r.value, 0) / recent.length) * 10,
          ) / 10
        : null;

    const metric = thresholdMetricForContext(ctx);
    const eff = getEffectiveRange(metric, profileForRange, overrides);
    const range = eff.range
      ? { min: eff.range.greenMin, max: eff.range.greenMax }
      : null;

    let classification: { category: string; color: string } | null = null;
    if (range) {
      if (latest >= range.min && latest <= range.max) {
        classification = { category: "Optimal", color: "#50fa7b" };
      } else if (
        eff.range &&
        latest >= eff.range.orangeMin &&
        latest <= eff.range.orangeMax
      ) {
        classification = { category: "Elevated", color: "#f1fa8c" };
      } else {
        classification = { category: "High", color: "#ff5555" };
      }
    }

    const consistency = rollupConsistency(
      recent.map((r) => ({ measuredAt: r.measuredAt, value: r.value })),
      makeRangeClassifier(
        range,
        eff.range
          ? { orangeMin: eff.range.orangeMin, orangeMax: eff.range.orangeMax }
          : undefined,
      ),
    );
    targets.push({
      type: `BLOOD_GLUCOSE_${ctx}`,
      label: labelKeyByContext[ctx],
      current: latest,
      average30: avg30,
      trend: null,
      unit: glucoseUnit,
      range,
      classification,
      source: eff.isOverride ? "Custom" : "ADA 2024 / DDG",
      ...consistency,
    });
  }

  // --------------------------------------------------------------------
  // v1.4.25 W3e — page summary. "X of Y targets met this week" is the
  // single most-asked-about glanceable answer. We define "met this
  // week" as the target having `daysInRange7d >= 4` AND not flagged as
  // `insufficientData`. The streak highlight surfaces the metric with
  // the longest current ≥ 3 day streak; nothing renders client-side
  // when no target hits the bar.
  // --------------------------------------------------------------------
  const targetsMetThisWeek = targets.filter(
    (target) => !target.insufficientData && target.daysInRange7d >= 4,
  ).length;
  let streakHighlight: TargetPageSummary["streakHighlight"] = null;
  for (const target of targets) {
    if (target.streakDays < 3) continue;
    if (!streakHighlight || target.streakDays > streakHighlight.days) {
      streakHighlight = { metric: target.type, days: target.streakDays };
    }
  }
  const pageSummary: TargetPageSummary = {
    targetsMetThisWeek,
    totalTargets: targets.length,
    streakHighlight,
  };

  annotate({
    action: { name: "insights.targets" },
    meta: {
      targetCount: targets.length,
      targetsMetThisWeek,
      streakHighlightMetric: streakHighlight?.metric ?? null,
    },
  });

  return apiSuccess({
    targets,
    pageSummary,
    // Extra diastolic data for BP display
    bpDiastolic: {
      current: latestByType.BLOOD_PRESSURE_DIA ?? null,
      average30: avg30ByType.BLOOD_PRESSURE_DIA ?? null,
      range: bpRange ? { min: bpRange.diaLow, max: bpRange.diaHigh } : null,
    },
    profile: {
      heightCm,
      age,
      gender,
      glucoseUnit,
    },
  });
});
