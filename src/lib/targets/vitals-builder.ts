import {
  classifyBMI,
  classifyBodyFat,
  classifyBP,
  classifySteps,
  getBpTargetsByAge,
  getStepsRange,
  getWeightRange,
} from "@/lib/analytics/classifications";
import { isBpReadingInTarget } from "@/lib/analytics/bp-in-target";
import { pairByTimestamp } from "@/lib/analytics/correlations";
import {
  classifyPulseByTarget,
  getPersonalizedPulseTarget,
} from "@/lib/analytics/pulse-targets";
import {
  mergeRestingWithProxy,
  type PulseSample,
} from "@/lib/analytics/resting-pulse";
import { getBodyFatTargetRange } from "@/lib/analytics/value-bands";
import { binaryReferenceSex, type ProfileSex } from "@/lib/profile/sex";
import { userDayKey } from "@/lib/tz/resolver";
import {
  makeRangeClassifier,
  rollupConsistency,
  rollupFromDayMap,
} from "./consistency";
import type {
  DayBand,
  TargetItem,
  TargetMeasurement,
  TargetTrend,
  TargetValueByType,
} from "./types";

export interface BloodPressureTargetRange {
  sysLow: number;
  sysHigh: number;
  diaLow: number;
  diaHigh: number;
}

interface VitalTargetsInput {
  /** The last thirty days of every vital type except `PULSE`. */
  recentMeasurements: TargetMeasurement[];
  /**
   * The resting-pulse proxy over the same thirty days, one point per local
   * day, folded from raw `PULSE` in Postgres (`readRestingPulseProxy`). Raw
   * heart rate is never read here: a watch that records it once a minute puts
   * 43 000 readings in thirty days, and the card needs one figure per day.
   */
  restingPulseProxy: PulseSample[];
  latestByType: TargetValueByType;
  average30ByType: TargetValueByType;
  heightCm: number | null;
  age: number | null;
  /** Sex as stored, `OTHER` included; narrowed per formula below. */
  gender: ProfileSex;
  timezone: string;
  now: Date;
  /**
   * v1.34 — the user's own weight band from `User.thresholdsJson`, in kg.
   * When present it replaces the WHO BMI band on the weight card and the
   * card's source reads "Custom", matching how the glucose builder has
   * always treated a user override. `null` keeps the height-derived band.
   */
  weightTargetOverride: { min: number; max: number } | null;
  /**
   * The user's own blood-pressure band from `User.thresholdsJson`
   * (`resolveBpTargetOverride`). When present it replaces the age-based ESH
   * band on the card, its in-target share and its seven-day strip, and the
   * source reads "Custom" — the same rule as the weight override above. The
   * ESH classification of the latest reading stays guideline-derived: it
   * names a category, not a goal. Absent or `null` keeps the age band.
   */
  bpTargetOverride?: BloodPressureTargetRange | null;
  /**
   * Whether the adult WHO weight and BMI cut-offs apply. No band here knows a
   * child's age yet, so for a record under 18, or a managed one with no date
   * of birth, the weight card keeps only the record's own target, the BMI
   * card names no band, and neither names a category. Absent means they do.
   */
  adultBands?: boolean;
}

export interface VitalTargetsResult {
  targets: TargetItem[];
  bpRange: BloodPressureTargetRange | null;
}

function computeTrend(
  recentMeasurements: TargetMeasurement[],
  type: TargetMeasurement["type"],
): TargetTrend {
  const data = recentMeasurements
    .filter((measurement) => measurement.type === type)
    .sort((a, b) => a.measuredAt.getTime() - b.measuredAt.getTime());
  if (data.length < 4) return null;

  const mid = Math.floor(data.length / 2);
  const firstHalf = data.slice(0, mid);
  const secondHalf = data.slice(mid);
  const averageFirst =
    firstHalf.reduce((sum, measurement) => sum + measurement.value, 0) /
    firstHalf.length;
  const averageSecond =
    secondHalf.reduce((sum, measurement) => sum + measurement.value, 0) /
    secondHalf.length;
  const difference = averageSecond - averageFirst;
  const threshold = averageFirst * 0.02;
  if (difference > threshold) return "up";
  if (difference < -threshold) return "down";
  return "stable";
}

function buildBpPairsByDay(
  recentMeasurements: TargetMeasurement[],
  bpRange: BloodPressureTargetRange | null,
  timezone: string,
): Map<string, DayBand | null> {
  if (!bpRange) return new Map();
  const systolicByDay = new Map<string, Array<{ date: Date; value: number }>>();
  const diastolicByDay = new Map<
    string,
    Array<{ date: Date; value: number }>
  >();
  for (const measurement of recentMeasurements) {
    if (measurement.type === "BLOOD_PRESSURE_SYS") {
      const key = userDayKey(measurement.measuredAt, timezone);
      const points = systolicByDay.get(key) ?? [];
      points.push({ date: measurement.measuredAt, value: measurement.value });
      systolicByDay.set(key, points);
    } else if (measurement.type === "BLOOD_PRESSURE_DIA") {
      const key = userDayKey(measurement.measuredAt, timezone);
      const points = diastolicByDay.get(key) ?? [];
      points.push({ date: measurement.measuredAt, value: measurement.value });
      diastolicByDay.set(key, points);
    }
  }

  const bands = new Map<string, DayBand | null>();
  const dayKeys = new Set([...systolicByDay.keys(), ...diastolicByDay.keys()]);
  for (const key of dayKeys) {
    const pairs = pairByTimestamp(
      systolicByDay.get(key) ?? [],
      diastolicByDay.get(key) ?? [],
      5 * 60 * 1000,
    );
    if (pairs.length === 0) {
      bands.set(key, null);
      continue;
    }
    const inTargetCount = pairs.filter((pair) =>
      isBpReadingInTarget(pair.a, pair.b, bpRange),
    ).length;
    bands.set(
      key,
      inTargetCount === pairs.length
        ? "in"
        : inTargetCount > 0
          ? "near"
          : "out",
    );
  }
  return bands;
}

export function buildVitalTargets({
  recentMeasurements,
  restingPulseProxy,
  latestByType,
  average30ByType,
  heightCm,
  age,
  gender,
  timezone,
  now,
  weightTargetOverride,
  bpTargetOverride = null,
  adultBands = true,
}: VitalTargetsInput): VitalTargetsResult {
  const targets: TargetItem[] = [];
  const consistencyClock = { timezone, now };
  // The BP / pulse / body-fat tables are published for two groups and have
  // no third row. Narrow once, here, where that is true — each helper
  // answers a null with a neutral value, never with one of the two sides.
  const referenceSex = binaryReferenceSex(gender);

  // v1.34 — a user-set target outranks the WHO BMI band. The BMI
  // classification below stays WHO-derived either way: it names which BMI
  // category a reading falls in, which is a reference fact and not a goal.
  const whoHeightCm = adultBands ? heightCm : null;
  const weightRange =
    weightTargetOverride ?? (whoHeightCm ? getWeightRange(whoHeightCm) : null);
  let weightClassification: TargetItem["classification"] = null;
  if (latestByType.WEIGHT != null && whoHeightCm) {
    const heightM = whoHeightCm / 100;
    const classification = classifyBMI(
      latestByType.WEIGHT / (heightM * heightM),
    );
    weightClassification = {
      category: classification.category,
      color: classification.color,
    };
  }
  targets.push({
    type: "WEIGHT",
    label: "Weight",
    current: latestByType.WEIGHT ?? null,
    average30: average30ByType.WEIGHT ?? null,
    trend: computeTrend(recentMeasurements, "WEIGHT"),
    unit: "kg",
    range: weightRange,
    classification: weightClassification,
    source: weightTargetOverride ? "Custom" : "WHO BMI",
    ...rollupConsistency({
      events: recentMeasurements.filter(
        (measurement) => measurement.type === "WEIGHT",
      ),
      classify: makeRangeClassifier(weightRange),
      ...consistencyClock,
    }),
  });

  const bpRange =
    bpTargetOverride ??
    (age != null ? getBpTargetsByAge(age, referenceSex) : null);
  const bpPairsByDay = buildBpPairsByDay(recentMeasurements, bpRange, timezone);
  let bpClassification: TargetItem["classification"] = null;
  if (
    latestByType.BLOOD_PRESSURE_SYS != null &&
    latestByType.BLOOD_PRESSURE_DIA != null
  ) {
    const classification = classifyBP(
      latestByType.BLOOD_PRESSURE_SYS,
      latestByType.BLOOD_PRESSURE_DIA,
    );
    bpClassification = {
      category: classification.category,
      color: classification.color,
    };
  }
  targets.push({
    type: "BLOOD_PRESSURE",
    label: "Blood pressure",
    current: latestByType.BLOOD_PRESSURE_SYS ?? null,
    average30: average30ByType.BLOOD_PRESSURE_SYS ?? null,
    trend: computeTrend(recentMeasurements, "BLOOD_PRESSURE_SYS"),
    unit: "mmHg",
    range: bpRange ? { min: bpRange.sysLow, max: bpRange.sysHigh } : null,
    classification: bpClassification,
    source: bpTargetOverride ? "Custom" : "ESH 2023",
    ...rollupFromDayMap({
      dayBandByKey: bpPairsByDay,
      ...consistencyClock,
    }),
  });

  if (bpRange) {
    const systolicPoints = recentMeasurements
      .filter((measurement) => measurement.type === "BLOOD_PRESSURE_SYS")
      .map((measurement) => ({
        date: measurement.measuredAt,
        value: measurement.value,
      }));
    const diastolicPoints = recentMeasurements
      .filter((measurement) => measurement.type === "BLOOD_PRESSURE_DIA")
      .map((measurement) => ({
        date: measurement.measuredAt,
        value: measurement.value,
      }));
    const pairs = pairByTimestamp(
      systolicPoints,
      diastolicPoints,
      5 * 60 * 1000,
    );
    const inTargetCount = pairs.filter((pair) =>
      isBpReadingInTarget(pair.a, pair.b, bpRange),
    ).length;
    const rate =
      pairs.length > 0
        ? Math.round((inTargetCount / pairs.length) * 100 * 10) / 10
        : null;
    targets.push({
      type: "BLOOD_PRESSURE_IN_TARGET",
      label: "Blood pressure on target",
      current: rate,
      average30: rate,
      trend: null,
      unit: "%",
      range: { min: 70, max: 100 },
      classification:
        rate != null
          ? rate >= 70
            ? { category: "Good", color: "var(--success)" }
            : rate >= 40
              ? { category: "Moderate", color: "var(--dracula-yellow)" }
              : { category: "Low", color: "var(--destructive)" }
          : null,
      source: "ESH 2023",
      ...rollupFromDayMap({
        dayBandByKey: bpPairsByDay,
        ...consistencyClock,
      }),
    });
  }

  const pulseTarget = getPersonalizedPulseTarget(age, referenceSex);
  const restingResolved = mergeRestingWithProxy({
    restingSamples: recentMeasurements
      .filter((measurement) => measurement.type === "RESTING_HEART_RATE")
      .map((measurement) => ({
        measuredAt: measurement.measuredAt,
        value: measurement.value,
      })),
    proxySamples: restingPulseProxy,
    dayKeyOf: (date) => userDayKey(date, timezone),
  });
  const restingEvents = restingResolved.series;
  const restingCurrent =
    restingEvents.length > 0
      ? restingEvents[restingEvents.length - 1].value
      : null;
  const restingAverage =
    restingEvents.length > 0
      ? Math.round(
          (restingEvents.reduce((sum, event) => sum + event.value, 0) /
            restingEvents.length) *
            10,
        ) / 10
      : null;
  let pulseClassification: TargetItem["classification"] = null;
  if (restingCurrent != null) {
    const classification = classifyPulseByTarget(restingCurrent, pulseTarget);
    pulseClassification = {
      category: classification.category,
      color: classification.color,
    };
  }
  const pulseRange = {
    min: pulseTarget.greenMin,
    max: pulseTarget.greenMax,
  };
  let restingTrend: TargetTrend = null;
  if (restingEvents.length >= 4) {
    const sorted = [...restingEvents].sort(
      (a, b) => a.measuredAt.getTime() - b.measuredAt.getTime(),
    );
    const mid = Math.floor(sorted.length / 2);
    const averageFirst =
      sorted.slice(0, mid).reduce((sum, event) => sum + event.value, 0) / mid;
    const averageSecond =
      sorted.slice(mid).reduce((sum, event) => sum + event.value, 0) /
      (sorted.length - mid);
    const difference = averageSecond - averageFirst;
    const threshold = averageFirst * 0.02;
    restingTrend =
      difference > threshold
        ? "up"
        : difference < -threshold
          ? "down"
          : "stable";
  }
  targets.push({
    type: "PULSE",
    label: "Resting pulse",
    current: restingCurrent,
    average30: restingAverage,
    trend: restingTrend,
    unit: "bpm",
    range: pulseRange,
    classification: pulseClassification,
    source:
      restingResolved.which === "proxy"
        ? `${pulseTarget.source} (estimated from heart rate)`
        : pulseTarget.source,
    ...rollupConsistency({
      events: restingEvents,
      classify: makeRangeClassifier(pulseRange, {
        orangeMin: pulseTarget.orangeMin,
        orangeMax: pulseTarget.orangeMax,
      }),
      ...consistencyClock,
    }),
  });

  if (heightCm) {
    const heightM = heightCm / 100;
    const heightSquared = heightM * heightM;
    const latestWeight = latestByType.WEIGHT ?? null;
    const currentBmi =
      latestWeight != null
        ? Math.round((latestWeight / heightSquared) * 10) / 10
        : null;
    const averageWeight = average30ByType.WEIGHT ?? null;
    const averageBmi =
      averageWeight != null
        ? Math.round((averageWeight / heightSquared) * 10) / 10
        : null;
    let bmiClassification: TargetItem["classification"] = null;
    if (currentBmi != null && adultBands) {
      const classification = classifyBMI(currentBmi);
      bmiClassification = {
        category: classification.category,
        color: classification.color,
      };
    }
    const bmiRange = adultBands ? { min: 18.5, max: 24.9 } : null;
    targets.push({
      type: "BMI",
      label: "BMI",
      current: currentBmi,
      average30: averageBmi,
      trend: computeTrend(recentMeasurements, "WEIGHT"),
      unit: "kg/m²",
      range: bmiRange,
      classification: bmiClassification,
      source: "WHO",
      ...rollupConsistency({
        events: recentMeasurements
          .filter((measurement) => measurement.type === "WEIGHT")
          .map((measurement) => ({
            measuredAt: measurement.measuredAt,
            value: measurement.value / heightSquared,
          })),
        classify: makeRangeClassifier(bmiRange),
        ...consistencyClock,
      }),
    });
  }

  let bodyFatClassification: TargetItem["classification"] = null;
  if (latestByType.BODY_FAT != null && age != null) {
    const classification = classifyBodyFat(
      latestByType.BODY_FAT,
      referenceSex,
      age,
    );
    bodyFatClassification = {
      category: classification.category,
      color: classification.color,
    };
  }
  const bodyFatRange = age != null ? getBodyFatTargetRange(referenceSex) : null;
  targets.push({
    type: "BODY_FAT",
    label: "Body fat",
    current: latestByType.BODY_FAT ?? null,
    average30: average30ByType.BODY_FAT ?? null,
    trend: computeTrend(recentMeasurements, "BODY_FAT"),
    unit: "%",
    range: bodyFatRange,
    classification: bodyFatClassification,
    source: "ACE",
    ...rollupConsistency({
      events: recentMeasurements.filter(
        (measurement) => measurement.type === "BODY_FAT",
      ),
      classify: makeRangeClassifier(bodyFatRange),
      ...consistencyClock,
    }),
  });

  const stepsRange = getStepsRange();
  let stepsClassification: TargetItem["classification"] = null;
  if (average30ByType.ACTIVITY_STEPS != null) {
    const classification = classifySteps(average30ByType.ACTIVITY_STEPS);
    stepsClassification = {
      category: classification.category,
      color: classification.color,
    };
  }
  targets.push({
    type: "ACTIVITY_STEPS",
    label: "Steps/day",
    current: latestByType.ACTIVITY_STEPS ?? null,
    average30: average30ByType.ACTIVITY_STEPS ?? null,
    trend: computeTrend(recentMeasurements, "ACTIVITY_STEPS"),
    unit: "steps",
    range: stepsRange,
    classification: stepsClassification,
    source: "Saint-Maurice JAMA 2020",
    ...rollupConsistency({
      events: recentMeasurements.filter(
        (measurement) => measurement.type === "ACTIVITY_STEPS",
      ),
      classify: makeRangeClassifier(stepsRange),
      ...consistencyClock,
    }),
  });

  return { targets, bpRange };
}
