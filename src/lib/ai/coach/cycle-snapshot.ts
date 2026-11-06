/**
 * Cycle/phase snapshot block builder for the Coach prompt (v1.15).
 *
 * Adds a cycle dimension to the Coach snapshot so the model can say "you are on
 * day 22, luteal phase" and reference the user's own phase-correlation finding,
 * grounded in the same engine the calendar + insights surface use — never
 * re-derived. The block carries three things, each present only when actually
 * computed (shown == sent):
 *
 *   1. current phase + 1-based day-of-cycle (from the deterministic phase
 *      engine),
 *   2. the next predicted event — period range + confidence + method, plus the
 *      fertile window ONLY when the goal surfaces it (TRYING_TO_CONCEIVE),
 *   3. the ONE headline phase insight — the FDR-surviving luteal-vs-follicular
 *      contrast (the comparison already finished, the metric-signal posture:
 *      hand the model the numbers, do not make it re-derive them).
 *
 * Gated entirely on `isCycleEnabled` by the caller, so a non-cycle account's
 * snapshot is byte-for-byte unchanged. The Coach system prompt's cycle ground
 * rule keeps this descriptive only — never contraception-grade, never a "safe
 * day" claim.
 */
import { prisma } from "@/lib/db";
import {
  applyDisplayTransform,
  applyDisplayTransformDelta,
  getReadingTransform,
  isUnitSensitiveType,
  resolveUnitPreferences,
  type UnitPreferences,
} from "@/lib/measurements/display-transform";
import { resolveLuteal } from "@/lib/cycle";
import type { CyclePhase } from "@/lib/cycle/types";
import {
  phaseForDate,
  buildPhaseDayMap,
  gatedPrediction,
  toCycleInputs,
} from "@/lib/cycle/engine-adapter";
import {
  defaultCalendarDayLogStart,
  loadCycleEngineInputs,
} from "@/lib/cycle/load-inputs";
import { PROJECTION_MAX_HORIZON, projectCycles } from "@/lib/cycle/projection";
import type { CycleProfileInput } from "@/lib/cycle/types";
import { goalAllowsFertileWindow } from "@/lib/cycle/dto";
import {
  computePhaseMetricCrosstab,
  selectHeadlinePhaseRow,
  PHASE_CROSSTAB_METRIC_TYPES,
  PHASE_CROSSTAB_METRICS,
  type PhaseMetricCrosstabRow,
} from "@/lib/cycle/phase-crosstab";
import type { CrossMetricMeasurement } from "@/lib/insights/mood-aggregates";
import { addDays } from "@/lib/cycle/day-math";
import { readSourceDayAggregates } from "@/lib/measurements/day-aggregates";
import { moodDateKey } from "@/lib/mood/date-key";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";
import { startOfLocalDayKey } from "@/lib/tz/local-day";

/** Trailing window the phase contrast walks (days). Mirrors the read route. */
const WINDOW_DAYS = 365;

/** Natural-language metric labels (no enum leak into the prompt). */
const METRIC_LABEL: Record<string, string> = {
  restingHeartRate: "resting heart rate",
  heartRateVariability: "heart-rate variability",
  sleepDuration: "sleep duration",
  steps: "steps",
  weight: "weight",
  basalBodyTemp: "basal body temperature",
  wristTemperature: "overnight wrist temperature",
  skinTemperature: "skin temperature",
};

/**
 * Labels for the display kinds no preference changes. Weight, the
 * temperatures and glucose are read in the reader's units instead, through
 * the measurement type's transform (see `headlineInReaderUnits`).
 */
const UNIT_LABEL: Record<string, string> = {
  hours: "h",
  steps: "steps",
  bpm: "bpm",
  ms: "ms",
};

interface PhaseInsightBlock {
  metric: string;
  unit: string;
  lutealAvg: number;
  follicularAvg: number;
  /** lutealAvg − follicularAvg; positive = higher in the luteal phase. */
  delta: number;
  /** The finding's confidence band (p + per-group day count). */
  confidence: PhaseMetricCrosstabRow["confidence"];
  /** Benjamini-Hochberg q-value across the tested family. */
  qValue: number;
  lutealDays: number;
  follicularDays: number;
  /** One-line descriptive interpretation — never causal. */
  interpretation: string;
}

interface NextEventBlock {
  nextPeriodStart: string;
  nextPeriodStartLow: string;
  nextPeriodStartHigh: string;
  daysUntilPeriod: number;
  method: string;
  confidence: number;
  stillLearning: boolean;
  /** Goal-gated — present only when the goal surfaces the fertile window. */
  fertileWindowStart?: string;
  fertileWindowEnd?: string;
}

/** One projected period start with its band (#1350). */
interface UpcomingCycleBlock {
  start: string;
  earliestStart: string;
  latestStart: string;
}

export interface CycleSnapshotBlock {
  phase: CyclePhase | null;
  dayOfCycle: number | null;
  goal: string;
  cyclesObserved: number;
  nextEvent: NextEventBlock | null;
  /**
   * The next period and the ones after it, widening, self-capped where the
   * band passes ±10 days or half a cycle. Empty while prediction is off, while
   * the next period is later than its band, or with no logged cycle.
   */
  upcoming: UpcomingCycleBlock[];
  phaseInsight: PhaseInsightBlock | null;
}

/**
 * The headline contrast's figures in the reader's units. The two means take
 * the full transform, the difference the factor alone; a kind no preference
 * touches keeps its numbers and its fixed label.
 */
function headlineInReaderUnits(
  row: PhaseMetricCrosstabRow,
  units: UnitPreferences,
): { lutealAvg: number; follicularAvg: number; delta: number; unit: string } {
  const type = PHASE_CROSSTAB_METRICS[row.metricKey].type;
  if (!isUnitSensitiveType(type)) {
    return {
      lutealAvg: row.lutealAvg,
      follicularAvg: row.follicularAvg,
      delta: row.delta,
      unit: UNIT_LABEL[row.display] ?? "",
    };
  }
  const transform = getReadingTransform(type, units);
  return {
    lutealAvg: applyDisplayTransform(row.lutealAvg, transform),
    follicularAvg: applyDisplayTransform(row.follicularAvg, transform),
    delta: applyDisplayTransformDelta(row.delta, transform),
    unit: transform.displayUnit,
  };
}

/** Descriptive, never-causal interpretation of the headline contrast. */
function interpretHeadline(
  row: PhaseMetricCrosstabRow,
  shown: { delta: number; unit: string },
): string {
  const metric = METRIC_LABEL[row.metricKey] ?? row.metricKey;
  const dir = shown.delta >= 0 ? "higher" : "lower";
  const mag = Math.abs(shown.delta);
  const unit = shown.unit;
  return `Your ${metric} runs about ${mag}${unit ? " " + unit : ""} ${dir} on luteal-phase days than follicular-phase days in your own data — a descriptive pattern, not a cause.`;
}

/**
 * Build the cycle snapshot block. Returns `null` when there is nothing to say
 * (no observed cycle → no phase, no prediction, no insight) so the caller omits
 * the field entirely. The caller has already confirmed `isCycleEnabled`.
 */
export async function buildCycleSnapshotBlock(
  userId: string,
  gender: string | null | undefined,
  now: Date = new Date(),
  timezone: string | null | undefined = DEFAULT_TIMEZONE,
): Promise<CycleSnapshotBlock | null> {
  // Test environments may mock only part of prisma — bow out silently if the
  // cycle models are absent (matches "no cycle data" production behaviour).
  if (typeof prisma?.menstrualCycle?.findMany !== "function") return null;
  if (typeof prisma?.cycleProfile?.findUnique !== "function") return null;

  const profile = await prisma.cycleProfile.findUnique({
    where: { userId },
    select: {
      goal: true,
      predictionEnabled: true,
      rawChartMode: true,
      lutealPhaseLength: true,
      typicalCycleLength: true,
      typicalPeriodLength: true,
      secondarySymptom: true,
    },
  });
  if (!profile) return null;

  const profileInput: CycleProfileInput = {
    goal: profile.goal,
    typicalCycleLength: profile.typicalCycleLength,
    typicalPeriodLength: profile.typicalPeriodLength,
    lutealPhaseLength: profile.lutealPhaseLength,
    predictionEnabled: profile.predictionEnabled,
    rawChartMode: profile.rawChartMode,
    secondarySymptom: profile.secondarySymptom,
  };

  // Derive "today" from the user's timezone — matches how the calendar
  // (calendar/route.ts) and insights routes resolve it, so the Coach's
  // "you are on day N / period in M days" never disagrees with the calendar
  // near local midnight.
  const tz = timezone ?? DEFAULT_TIMEZONE;
  const today = moodDateKey(now, tz);
  const from = addDays(today, -WINDOW_DAYS);

  const [inputs, measurementRows, userRow] = await Promise.all([
    // The forecast's inputs through the calendar's own loader and the
    // calendar's default day-log window, so "next period" here is the date the
    // calendar page shows (`load-inputs.ts`).
    loadCycleEngineInputs({
      userId,
      today,
      tz,
      dayLogsFrom: defaultCalendarDayLogStart(today),
    }),
    // A year of steps, heart-rate variability and CGM glucose is far too
    // many readings to hold as objects (#1023). The crosstab only needs
    // each day's sum and count per source and device, which is what the
    // per-source picker decides on, so the fold runs in SQL. Days are the
    // user's days, the ones `metricDayMap` keys on and the phase days are
    // dated in.
    readSourceDayAggregates({
      userId,
      types: PHASE_CROSSTAB_METRIC_TYPES,
      since: startOfLocalDayKey(from, tz),
      timeZone: tz,
    }),
    prisma.user.findUnique({
      where: { id: userId },
      select: {
        sourcePriorityJson: true,
        unitPreference: true,
        glucoseUnit: true,
      },
    }),
  ]);
  const { cycles } = inputs;

  if (cycles.length === 0) return null;

  // The engine's own clamp, so the phase this block names agrees with the
  // calendar's band for an out-of-range stored luteal length.
  const lutealLength = resolveLuteal(profileInput);
  const goalAllowsFertile = goalAllowsFertileWindow(profile.goal);

  const prediction = gatedPrediction(profileInput, inputs, today);

  const { phase, dayOfCycle } = phaseForDate(
    today,
    cycles,
    prediction?.nextPeriodStart ?? null,
    lutealLength,
    today,
  );

  // Next predicted event — period range + confidence + method, fertile window
  // goal-gated.
  let nextEvent: NextEventBlock | null = null;
  if (prediction) {
    const daysUntilPeriod = Math.max(
      0,
      Math.round(
        (Date.parse(`${prediction.nextPeriodStart}T12:00:00Z`) -
          Date.parse(`${today}T12:00:00Z`)) /
          86_400_000,
      ),
    );
    nextEvent = {
      nextPeriodStart: prediction.nextPeriodStart,
      nextPeriodStartLow: prediction.nextPeriodStartLow,
      nextPeriodStartHigh: prediction.nextPeriodStartHigh,
      daysUntilPeriod,
      method: prediction.method,
      confidence: prediction.confidence,
      stillLearning: prediction.stillLearning,
      ...(goalAllowsFertile && prediction.fertileWindowStart
        ? { fertileWindowStart: prediction.fertileWindowStart }
        : {}),
      ...(goalAllowsFertile && prediction.fertileWindowEnd
        ? { fertileWindowEnd: prediction.fertileWindowEnd }
        : {}),
    };
  }

  // The cycles after the next one, from the same projection the calendar
  // publishes and the calendar feed serves. Dates and bands only.
  const projection = projectCycles({
    prediction,
    cycles: toCycleInputs(cycles),
    dayLogs: inputs.dayLogs,
    goal: profile.goal,
    today,
    horizon: PROJECTION_MAX_HORIZON,
  });
  const upcoming: UpcomingCycleBlock[] = projection.cycles.map((c) => ({
    start: c.start,
    earliestStart: c.bandStart,
    latestStart: c.bandEnd,
  }));

  // Headline phase insight — the FDR-surviving luteal-vs-follicular contrast.
  const phaseByDay = buildPhaseDayMap(
    cycles,
    prediction?.nextPeriodStart ?? null,
    lutealLength,
    from,
    today,
    today,
  );
  const measurements: CrossMetricMeasurement[] = measurementRows.map((m) => ({
    type: m.type,
    value: m.sum,
    count: m.n,
    measuredAt: m.firstAt,
    source: m.source,
    deviceType: m.deviceType,
  }));
  const headlineRow = selectHeadlinePhaseRow(
    computePhaseMetricCrosstab({
      phaseByDay,
      measurements,
      userPriorityJson: userRow?.sourcePriorityJson ?? null,
      timeZone: tz,
    }),
  );

  let phaseInsight: PhaseInsightBlock | null = null;
  if (headlineRow) {
    const shown = headlineInReaderUnits(
      headlineRow,
      resolveUnitPreferences({
        unitPreference: userRow?.unitPreference,
        glucoseUnit: userRow?.glucoseUnit,
      }),
    );
    phaseInsight = {
      metric: METRIC_LABEL[headlineRow.metricKey] ?? headlineRow.metricKey,
      unit: shown.unit,
      lutealAvg: shown.lutealAvg,
      follicularAvg: shown.follicularAvg,
      delta: shown.delta,
      confidence: headlineRow.confidence,
      qValue: headlineRow.qValue,
      lutealDays: headlineRow.lutealDays,
      follicularDays: headlineRow.follicularDays,
      interpretation: interpretHeadline(headlineRow, shown),
    };
  }

  // Nothing worth saying → omit the block.
  if (phase === null && nextEvent === null && phaseInsight === null) {
    return null;
  }

  return {
    phase,
    dayOfCycle,
    goal: profile.goal,
    cyclesObserved: cycles.length,
    nextEvent,
    upcoming,
    phaseInsight,
  };
}
