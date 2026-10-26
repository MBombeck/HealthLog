/**
 * The metric cards of `GET /api/dashboard/summary`: their wire shape, the
 * i18n keys they carry, the trend and verdict laid over them, and the
 * builders for each card the summary emits.
 *
 * The shape is fixed for the iOS client and intentionally normalised:
 * `kind` is iOS-friendly (camelCase), unlike the canonical Prisma enum
 * (BLOOD_PRESSURE_SYS etc.).
 */
import type { MeasurementType, SleepStage } from "@/generated/prisma/client";
import {
  resolveTrendVerdict,
  trendSentimentOfTrend,
  type TrendSentiment,
  type TrendVerdict,
  type TrendVerdictContext,
} from "@/lib/targets/trend-verdict";
import {
  reconstructSleepNights,
  type SleepSourceDiscrepancy,
  type SleepStageRow,
} from "@/lib/analytics/sleep-night";

export const SPARK_DAYS = 7;

export type MetricKind =
  | "weight"
  | "bloodPressure"
  | "pulse"
  | "bodyFat"
  | "glucose"
  | "sleep"
  | "steps"
  | "totalBodyWater"
  | "boneMass"
  | "oxygenSaturation"
  | "mood"
  | "bmi";

export interface MetricCard {
  id: string;
  kind: MetricKind;
  /**
   * i18n key for the metric's display title (e.g.
   * `dashboard.metric.title.weight`). Clients resolve the key against their
   * own locale bundle: the PWA via `useTranslations()`, the iOS client via
   * its bundled `Localizable.xcstrings`. The previous wire shape carried a
   * German string literal which injected DE into an English-locale iOS UI.
   */
  titleKey: string;
  latestValue: number | null;
  secondaryValue: number | null;
  /**
   * i18n key for the metric's display unit (e.g.
   * `dashboard.metric.unit.weight`). Same resolution contract as
   * `titleKey`. SI tokens like `kg`, `mmHg`, `bpm`, `mg/dL` are identical
   * across every shipped locale; per-kind keys keep the door open for
   * locale-specific overrides (e.g. Imperial units) without another
   * wire-shape change.
   */
  unitKey: string;
  /**
   * Explicit unit token for clients that need to know the value's unit
   * without inferring it from the metric kind. Most tiles leave this `null`
   * (the `unitKey` i18n key already carries the display unit). The `sleep`
   * tile sets it to `"h"` because its `latestValue` is a per-NIGHT total
   * expressed in HOURS (a float), not the canonical `SLEEP_DURATION`
   * minutes.
   */
  unit: string | null;
  /**
   * Per-stage hours for the headline night, sleep tile only. `null` for
   * every other kind and for a sleep night with no stage-tagged rows (a
   * legacy bare-duration night). Additive: a future sleep detail view can
   * render the breakdown without changing the headline `latestValue`.
   */
  sleepStages: Partial<Record<SleepStage, number>> | null;
  /**
   * Source-discrepancy annotation for the headline night's MAIN session,
   * sleep tile only; `null` for every other kind and for a night whose
   * writers agree. Additive (the established wire pattern for the
   * iOS-locked shape): observational only; `latestValue` stays the winning
   * writer's total; clients render a discreet "sources disagree" hint next
   * to the number. Minutes are whole (rounded), matching the
   * `/api/sleep/night` serialisation.
   */
  sleepSourceDiscrepancy: SleepSourceDiscrepancy | null;
  trend: "up" | "down" | "flat" | "unknown";
  sparkline: number[];
  updatedAt: string | null;
  /**
   * Total readings the user has ever logged for this metric, irrespective
   * of the 7-day sparkline window. The dashboard tile keeps showing
   * whenever `allTimeCount > 0` so a user with valid historical data isn't
   * surprised by a tile disappearing during a logging gap. Distinct from
   * `sparkline.length` which only carries the trailing-7-day points.
   */
  allTimeCount: number;
  /**
   * ISO timestamp of the metric's single most recent reading. When
   * `allTimeCount > 0` but the latest reading is older than 7 days, the iOS
   * tile renders a muted "last reading N days ago" caption so the user
   * understands the value isn't stale silently. `null` when the metric has
   * no readings at all.
   */
  lastSeenAt: string | null;
  /**
   * Which way a change of this metric counts for the person, against their
   * own target or a profile default (`src/lib/targets/trend-verdict.ts`).
   */
  direction?: TrendVerdict | null;
  /** `direction` applied to this card's `trend`. */
  trendSentiment?: TrendSentiment;
}

/**
 * The verdict key behind each card: the measurement type it reads, or the
 * derived key for the two cards that are not one.
 */
const VERDICT_KEY: Record<MetricKind, string> = {
  weight: "WEIGHT",
  bloodPressure: "BLOOD_PRESSURE_SYS",
  pulse: "PULSE",
  bodyFat: "BODY_FAT",
  glucose: "BLOOD_GLUCOSE",
  sleep: "SLEEP_DURATION",
  steps: "ACTIVITY_STEPS",
  totalBodyWater: "TOTAL_BODY_WATER",
  boneMass: "BONE_MASS",
  oxygenSaturation: "OXYGEN_SATURATION",
  mood: "MOOD",
  bmi: "BMI",
};

/**
 * Lay the verdict over each card. The reference placed against the band is
 * the mean of the card's own seven-day sparkline, else its latest value, the
 * seven-day average the web tiles place. Sleep cards are in hours and the
 * verdict reads minutes.
 */
export function withVerdicts(
  cards: MetricCard[],
  ctx: Omit<TrendVerdictContext, "referenceValue">,
): MetricCard[] {
  const referenceOf = (card: MetricCard | undefined): number | null => {
    if (!card) return null;
    const spark = card.sparkline.filter((v) => Number.isFinite(v));
    return spark.length > 0
      ? spark.reduce((sum, v) => sum + v, 0) / spark.length
      : card.latestValue;
  };
  // BMI is judged by the weight it is derived from (the target is a weight).
  const weightReference = referenceOf(cards.find((c) => c.kind === "weight"));
  return cards.map((card) => {
    const reference = card.kind === "bmi" ? weightReference : referenceOf(card);
    const direction = resolveTrendVerdict(VERDICT_KEY[card.kind], {
      ...ctx,
      referenceValue:
        reference !== null && card.kind === "sleep"
          ? reference * 60
          : reference,
    });
    return {
      ...card,
      direction,
      trendSentiment: trendSentimentOfTrend(card.trend, direction),
    };
  });
}

/**
 * Wire i18n keys, not translated strings. The legacy maps emitted German
 * literals like "Gewicht" / "Schritte" which injected into an English iOS UI
 * once the iOS app flipped its source language. Clients now resolve these
 * keys against their own locale bundle (the PWA via `useTranslations()`, iOS
 * via `Localizable.xcstrings`). The server payload becomes language-neutral
 * and the response shrinks slightly.
 *
 * One key per `MetricKind`: symmetric maps so a new kind has to add both a
 * title and a unit key (Type-checked: `Record<MetricKind, string>`).
 */
const METRIC_TITLE_KEYS: Record<MetricKind, string> = {
  weight: "dashboard.metric.title.weight",
  bloodPressure: "dashboard.metric.title.bloodPressure",
  pulse: "dashboard.metric.title.pulse",
  bodyFat: "dashboard.metric.title.bodyFat",
  glucose: "dashboard.metric.title.glucose",
  sleep: "dashboard.metric.title.sleep",
  steps: "dashboard.metric.title.steps",
  totalBodyWater: "dashboard.metric.title.totalBodyWater",
  boneMass: "dashboard.metric.title.boneMass",
  oxygenSaturation: "dashboard.metric.title.oxygenSaturation",
  mood: "dashboard.metric.title.mood",
  bmi: "dashboard.metric.title.bmi",
};

const METRIC_UNIT_KEYS: Record<MetricKind, string> = {
  weight: "dashboard.metric.unit.weight",
  bloodPressure: "dashboard.metric.unit.bloodPressure",
  pulse: "dashboard.metric.unit.pulse",
  bodyFat: "dashboard.metric.unit.bodyFat",
  glucose: "dashboard.metric.unit.glucose",
  sleep: "dashboard.metric.unit.sleep",
  steps: "dashboard.metric.unit.steps",
  totalBodyWater: "dashboard.metric.unit.totalBodyWater",
  boneMass: "dashboard.metric.unit.boneMass",
  oxygenSaturation: "dashboard.metric.unit.oxygenSaturation",
  mood: "dashboard.metric.unit.mood",
  bmi: "dashboard.metric.unit.bmi",
};

/**
 * The sleep sparkline: the trailing nights' TIME-ASLEEP in hours,
 * reconstructed per night from the raw stage rows. The generic DAY-bucket
 * rollup sparkline can't be used for sleep because it means across the
 * per-stage rows (e.g. a 60-min DEEP row and a 240-min CORE row average to
 * 150) rather than summing them into a night total.
 */
export function buildSleepSparkline(
  rows: SleepStageRow[],
  tz: string,
  priorityJson: unknown,
): number[] {
  return reconstructSleepNights(rows, tz, priorityJson)
    .filter((n) => n.asleepMinutes > 0)
    .map((n) => Math.round((n.asleepMinutes / 60) * 100) / 100)
    .slice(-SPARK_DAYS);
}

export function trendOf(values: number[]): MetricCard["trend"] {
  if (values.length < 2) return "unknown";
  const first = values[0];
  const last = values[values.length - 1];
  const delta = last - first;
  const epsilon = Math.max(1, Math.abs(first) * 0.01);
  if (Math.abs(delta) < epsilon) return "flat";
  return delta > 0 ? "up" : "down";
}

/** A card with no sleep extras, from its reading and its spark. */
export function plainCard(
  id: string,
  kind: MetricKind,
  card: {
    latestValue: number | null;
    secondaryValue?: number | null;
    spark: number[];
    updatedAt: string | null;
    allTimeCount: number;
    lastSeenAt: string | null;
  },
): MetricCard {
  return {
    id,
    kind,
    titleKey: METRIC_TITLE_KEYS[kind],
    latestValue: card.latestValue,
    secondaryValue: card.secondaryValue ?? null,
    unitKey: METRIC_UNIT_KEYS[kind],
    unit: null,
    sleepStages: null,
    sleepSourceDiscrepancy: null,
    trend: trendOf(card.spark),
    sparkline: card.spark,
    updatedAt: card.updatedAt,
    allTimeCount: card.allTimeCount,
    lastSeenAt: card.lastSeenAt,
  };
}

/** The sleep card: the latest night's TIME ASLEEP in hours. */
export function sleepCard(card: {
  latestValue: number | null;
  sleepStages: Partial<Record<SleepStage, number>> | null;
  sleepSourceDiscrepancy: SleepSourceDiscrepancy | null;
  spark: number[];
  updatedAt: string | null;
  allTimeCount: number;
  lastSeenAt: string | null;
}): MetricCard {
  return {
    id: "sleep",
    kind: "sleep",
    titleKey: METRIC_TITLE_KEYS.sleep,
    latestValue: card.latestValue,
    secondaryValue: null,
    unitKey: METRIC_UNIT_KEYS.sleep,
    unit: "h",
    sleepStages: card.sleepStages,
    sleepSourceDiscrepancy: card.sleepSourceDiscrepancy,
    trend: trendOf(card.spark),
    sparkline: card.spark,
    updatedAt: card.updatedAt,
    allTimeCount: card.allTimeCount,
    lastSeenAt: card.lastSeenAt,
  };
}

/** The measurement types of the optional cards, in emit order. */
export const OPTIONAL_CARD_TYPES = [
  ["BLOOD_GLUCOSE", "glucose"],
  ["SLEEP_DURATION", "sleep"],
  ["ACTIVITY_STEPS", "steps"],
  ["TOTAL_BODY_WATER", "totalBodyWater"],
  ["BONE_MASS", "boneMass"],
  ["OXYGEN_SATURATION", "oxygenSaturation"],
] as const satisfies ReadonlyArray<readonly [MeasurementType, MetricKind]>;
