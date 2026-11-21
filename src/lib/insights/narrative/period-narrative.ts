/**
 * v1.11.0 — period-narrative CONTEXT assembler (Pillar 1, no LLM).
 *
 * `buildPeriodNarrativeContext(userId, { period, now })` assembles the
 * structured, compact, provenance-carrying data a LATER wave (B-W3) narrates.
 * This wave produces NO prose and makes NO LLM call: it is a pure assembly
 * over the rollup tier + derived layer + the existing FDR-controlled
 * correlation engine. Every beat in the context is `label + number + source`
 * so the generator can ground each sentence in a citation, and so the surface
 * can render provenance chips.
 *
 * The honesty contract carries through verbatim from the layers it reuses:
 *  - **Drivers** are ONLY the BH-FDR-surviving pairs from `discoverCorrelations`
 *    (`benjaminiHochberg` already enforces descriptive-never-causal); each
 *    keeps its conservative `interpretation` string unchanged. The channels
 *    scanned come from the one shared assembler in
 *    `src/lib/insights/discovery-matrix.ts`, so this surface sees the same
 *    families the correlations page and the Coach do. It differs in exactly
 *    one declared way — it admits the user's RATED mood factors as
 *    `FACTOR:<key>` channels, which the three persisting surfaces do not; the
 *    reason is written at the `includeMoodFactors` option.
 *
 *    It also silently lacked, until the assembler landed, the
 *    medication-compliance, symptom-severity, environmental-exposure and
 *    custom-metric families, which had arrived at the route and never
 *    here. Nothing explained that; the comment that appeared to was the
 *    same sentence a sibling file carried while doing the opposite.
 *  - **Band transitions** are a personal-baseline (median ± k·MAD, Hampel/Leys)
 *    comparison of the current period against the band established over the
 *    PRIOR period — never an invented threshold.
 *  - **Coincident flags** carry the same `COINCIDENT_FIRE_THRESHOLD` / direction
 *    framing the live flag uses.
 *
 * Data-availability gate: the assembler returns an `insufficient`-style shape
 * (`{ status: "insufficient", reason, coverage }`) when the period has too
 * little history to narrate — never a fabricated story. The floor mirrors the
 * derived layer: ≥ 2 metrics each with ≥ `MIN_COVERED_DAYS_PER_METRIC` covered
 * days in the current period.
 *
 * Split into a PURE core (`assemblePeriodNarrativeContext`, fully unit-testable
 * over injected series, no DB) and a thin DB wrapper that fetches + day-keys +
 * delegates. The core is the one place the descriptive-only invariants live.
 */
import type { MeasurementType } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import type { Locale } from "@/lib/i18n/config";
import { annotate } from "@/lib/logging/context";
import { wallClockInTz } from "@/lib/tz/wall-clock";
import {
  discoverCorrelations,
  withoutModelFencedPairs,
  type DailySeriesPoint,
  type NamedSeries,
} from "@/lib/insights/correlation-discovery";
import { buildBaselineBand } from "@/lib/insights/derived/baseline";
import { VITALS_BASELINE_TYPES } from "@/lib/insights/derived/registry";
import { assembleDiscoveryMatrix } from "@/lib/insights/discovery-matrix";
import { resolveModuleMap } from "@/lib/modules/gate";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";
import {
  applyDisplayTransform,
  applyDisplayTransformDelta,
  getReadingTransform,
  isUnitSensitiveType,
  resolveUnitPreferences,
  type UnitPreferences,
} from "@/lib/measurements/display-transform";
import { median } from "@/lib/stats/central";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The two supported narrative periods and their length in days. */
export const PERIOD_DAYS = { week: 7, month: 30 } as const;
export type NarrativePeriod = keyof typeof PERIOD_DAYS;

/**
 * Availability floor — a narrative is only assembled when this many metrics
 * each clear the per-metric covered-day floor in the current period. Mirrors
 * the derived layer's `minInputs` / `READINESS_MIN_COMPONENTS` posture.
 */
export const MIN_METRICS_WITH_COVERAGE = 2;
/** Per-metric covered-day floor for the current period. */
export const MIN_COVERED_DAYS_PER_METRIC = 3;
/** A band must rest on at least this many prior-period days to be trusted. */
export const MIN_BASELINE_DAYS = 7;

/**
 * The metrics the period-delta beat scans. Their unit is not listed here: a
 * reading is narrated in the reader's unit (see `narratedUnit`), and the list
 * used to pin kilograms and mg/dL for everyone.
 */
const DELTA_METRICS: MeasurementType[] = [
  "WEIGHT",
  "BLOOD_PRESSURE_SYS",
  "BLOOD_PRESSURE_DIA",
  "PULSE",
  "RESTING_HEART_RATE",
  "HEART_RATE_VARIABILITY",
  "SLEEP_DURATION",
  "ACTIVITY_STEPS",
  "BODY_FAT",
  "BLOOD_GLUCOSE",
];

/**
 * Unit symbols of the narrated types whose unit no preference changes. The
 * sleep channel is a per-night total in minutes and is narrated in hours.
 */
const FIXED_NARRATED_UNITS: Partial<Record<MeasurementType, string>> = {
  BLOOD_PRESSURE_SYS: "mmHg",
  BLOOD_PRESSURE_DIA: "mmHg",
  PULSE: "bpm",
  RESTING_HEART_RATE: "bpm",
  HEART_RATE_VARIABILITY: "ms",
  RESPIRATORY_RATE: "breaths/min",
  OXYGEN_SATURATION: "%",
  SLEEP_DURATION: "h",
  ACTIVITY_STEPS: "",
  BODY_FAT: "%",
};

/**
 * How one narrated type is written for this reader: its unit symbol, the
 * conversion of an absolute value (a mean, a band edge) and of a difference
 * (a delta — factor only, never an affine offset). The computation itself
 * stays canonical, so the personal-band floors and the percent change do not
 * depend on the unit the reader chose.
 */
function narratedUnit(
  type: MeasurementType,
  units: UnitPreferences,
): {
  unit: string;
  abs: (canonical: number) => number;
  delta: (canonical: number) => number;
} {
  if (isUnitSensitiveType(type)) {
    const transform = getReadingTransform(type, units);
    return {
      unit: transform.displayUnit,
      // Rounded to the unit's own grain (one decimal for lb and mmol/L), the
      // grain every screen shows the same reading at.
      abs: (v) => round2(applyDisplayTransform(v, transform)),
      delta: (v) => round2(applyDisplayTransformDelta(v, transform)),
    };
  }
  if (type === "SLEEP_DURATION") {
    return {
      unit: "h",
      abs: (v) => round2(v / 60),
      delta: (v) => round2(v / 60),
    };
  }
  return {
    unit: FIXED_NARRATED_UNITS[type] ?? "",
    abs: round2,
    delta: round2,
  };
}

// ── context shape ───────────────────────────────────────────────────────

/** One metric's current-period mean vs the prior period of equal length. */
export interface MetricDelta {
  type: MeasurementType;
  unit: string;
  /** Mean of the per-day means over the current period; null when uncovered. */
  current: number | null;
  /** Mean over the prior period of equal length; null when uncovered. */
  prior: number | null;
  /** current − prior, rounded; null when either side is uncovered. */
  delta: number | null;
  /** delta as a percent of |prior|, rounded; null when not computable. */
  deltaPercent: number | null;
  /** Covered days in the current period (the provenance denominator). */
  currentDays: number;
  /** Covered days in the prior period. */
  priorDays: number;
}

/**
 * A vital whose current-period center crossed OUT of (or back INTO) its
 * personal band established over the prior period. Descriptive, MAD-based.
 */
export interface BandTransition {
  type: MeasurementType;
  /** Unit of `center` / `bandLow` / `bandHigh`, in the reader's preference. */
  unit: string;
  /** Current-period robust center (median of per-day means). */
  center: number;
  /** Prior-period band edges. */
  bandLow: number;
  bandHigh: number;
  /** "above" / "below" the band, or "in" when the center sits inside. */
  direction: "above" | "below" | "in";
  /** True when the center now sits outside the prior-period band. */
  movedOut: boolean;
  /** Prior-period days that established the band (≥ MIN_BASELINE_DAYS). */
  baselineDays: number;
}

/**
 * One FDR-surviving correlation, narrowed to the fields the generator cites.
 * Mirrors `DiscoveredCorrelation` but drops nothing material — the
 * `interpretation` is the conservative descriptive string, passed verbatim.
 */
export interface NarrativeDriver {
  behaviour: string;
  outcome: string;
  r: number;
  qValue: number;
  n: number;
  /** Conservative, descriptive interpretation — never causal, unchanged. */
  interpretation: string;
}

/** A day inside the period where ≥ 2 vitals sat outside their band together. */
export interface CoincidentFlag {
  day: string;
  /** The contributing vitals + their direction on that day. */
  vitals: Array<{ type: MeasurementType; direction: "above" | "below" }>;
}

/** Provenance envelope mirroring the Coach/derived chips. */
export interface NarrativeProvenance {
  /** The metric keys that actually backed a beat in this context. */
  metrics: string[];
  /** ISO window {from,to} of the read. */
  window: { from: string; to: string };
  /** Compute time (ISO 8601). */
  computedAt: string;
}

/** The successful, ready-to-narrate context object. */
export interface PeriodNarrativeContext {
  status: "ready";
  period: NarrativePeriod;
  metricDeltas: MetricDelta[];
  bandTransitions: BandTransition[];
  drivers: NarrativeDriver[];
  coincidentFlags: CoincidentFlag[];
  /** How many discovery pairs were tested (the honest footer). */
  pairsTested: number;
  /** The FDR target the drivers cleared. */
  fdrQ: number;
  provenance: NarrativeProvenance;
}

/** The gated arm — too little history to narrate honestly. */
export interface PeriodNarrativeInsufficient {
  status: "insufficient";
  period: NarrativePeriod;
  reason: string;
  /** Metrics that DID clear the per-metric floor (so the UI can nudge). */
  coverage: { metricsWithData: number; required: number };
}

export type PeriodNarrativeResult =
  PeriodNarrativeContext | PeriodNarrativeInsufficient;

// ── pure helpers ──────────────────────────────────────────────────────────

/** YYYY-MM-DD day key for an instant in the user's display timezone. */
function tzDayKey(at: Date, tz: string): string {
  const { year, month, day } = wallClockInTz(at, tz);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Round to 2 decimals. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Mean of a numeric array; null when empty. */
function meanOrNull(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

/** Partition a day-keyed series into the current vs prior period halves. */
function splitByPeriod(
  points: DailySeriesPoint[],
  currentFrom: string,
  priorFrom: string,
): { current: number[]; prior: number[] } {
  const current: number[] = [];
  const prior: number[] = [];
  for (const p of points) {
    if (p.day >= currentFrom) current.push(p.value);
    else if (p.day >= priorFrom) prior.push(p.value);
  }
  return { current, prior };
}

// ── pure core ──────────────────────────────────────────────────────────────

/** Per-metric day-keyed series spanning the full 2×period window. */
export interface AssembleInput {
  period: NarrativePeriod;
  /** Inclusive start of the current period (YYYY-MM-DD). */
  currentFrom: string;
  /** Inclusive start of the prior period (YYYY-MM-DD). */
  priorFrom: string;
  /** ISO window of the read for the provenance chip. */
  window: { from: string; to: string };
  /** Day-keyed series per metric, keyed by `MeasurementType` (+ MOOD). */
  seriesByMetric: Map<string, DailySeriesPoint[]>;
  /** Named series feeding the discovery matrix (same window). */
  discoverySeries: NamedSeries[];
  /**
   * The reader's locale for the drivers' narrated `interpretation`. Required —
   * the assembler writes sentences, so it has to be told which language they
   * are in rather than assuming one.
   */
  locale: Locale;
  /** Compute time (ISO). */
  computedAt: string;
  /**
   * The reader's unit preferences. Required for the same reason the locale
   * is: the context carries numbers a page and a prompt print verbatim, and a
   * caller that stays quiet must not get kilograms and mg/dL by default.
   */
  units: UnitPreferences;
}

/**
 * Pure assembler — given already-day-keyed series, build the typed context.
 * No DB, no LLM, no clock read (every time is injected). This is the unit
 * under test.
 */
export function assemblePeriodNarrativeContext(
  input: AssembleInput,
): PeriodNarrativeResult {
  const {
    period,
    currentFrom,
    priorFrom,
    window,
    seriesByMetric,
    discoverySeries,
    locale,
    computedAt,
    units,
  } = input;

  // ── metric deltas (current period vs prior period of equal length) ──────
  const metricDeltas: MetricDelta[] = [];
  const metricsWithCoverage: string[] = [];
  for (const type of DELTA_METRICS) {
    const shown = narratedUnit(type, units);
    const points = seriesByMetric.get(type) ?? [];
    const { current, prior } = splitByPeriod(points, currentFrom, priorFrom);
    const currentAvg = meanOrNull(current);
    const priorAvg = meanOrNull(prior);
    if (currentAvg === null && priorAvg === null) continue;
    if (current.length >= MIN_COVERED_DAYS_PER_METRIC) {
      metricsWithCoverage.push(type);
    }
    const delta =
      currentAvg !== null && priorAvg !== null
        ? round2(currentAvg - priorAvg)
        : null;
    // Percent on the canonical values: it is unit-free for a pure rescale,
    // and the one affine unit (°F) would otherwise move it.
    const deltaPercent =
      delta !== null && priorAvg !== null && priorAvg !== 0
        ? Math.round((delta / Math.abs(priorAvg)) * 1000) / 10
        : null;
    metricDeltas.push({
      type,
      unit: shown.unit,
      current: currentAvg === null ? null : shown.abs(currentAvg),
      prior: priorAvg === null ? null : shown.abs(priorAvg),
      delta:
        currentAvg !== null && priorAvg !== null
          ? shown.delta(currentAvg - priorAvg)
          : null,
      deltaPercent,
      currentDays: current.length,
      priorDays: prior.length,
    });
  }

  // ── availability gate ───────────────────────────────────────────────────
  if (metricsWithCoverage.length < MIN_METRICS_WITH_COVERAGE) {
    return {
      status: "insufficient",
      period,
      reason: "not_enough_history",
      coverage: {
        metricsWithData: metricsWithCoverage.length,
        required: MIN_METRICS_WITH_COVERAGE,
      },
    };
  }

  // ── derived-band transitions (prior-period band vs current center) ──────
  // The band is the personal typical range (median ± k·MAD) established over
  // the PRIOR period; a transition is the current-period center crossing it.
  // Never an invented threshold — same MAD basis as VITALS_BASELINE.
  const bandTransitions: BandTransition[] = [];
  for (const type of VITALS_BASELINE_TYPES) {
    const points = seriesByMetric.get(type) ?? [];
    const { current, prior } = splitByPeriod(points, currentFrom, priorFrom);
    if (prior.length < MIN_BASELINE_DAYS) continue;
    if (current.length < MIN_COVERED_DAYS_PER_METRIC) continue;
    const band = buildBaselineBand(prior, type);
    if (!band) continue;
    const center = median(current)!;
    const above = center > band.high;
    const below = center < band.low;
    const shown = narratedUnit(type, units);
    bandTransitions.push({
      type,
      unit: shown.unit,
      center: shown.abs(center),
      bandLow: shown.abs(band.low),
      bandHigh: shown.abs(band.high),
      direction: above ? "above" : below ? "below" : "in",
      movedOut: above || below,
      baselineDays: prior.length,
    });
  }

  // ── drivers (FDR-surviving correlations, descriptive-only) ──────────────
  const discovery = discoverCorrelations(discoverySeries, { locale });
  // The narrative is model input: pairs on a fenced channel stay out of it.
  const drivers: NarrativeDriver[] = withoutModelFencedPairs(
    discovery.discovered,
  ).map((d) => ({
    behaviour: d.behaviour,
    outcome: d.outcome,
    r: d.r,
    qValue: d.qValue,
    n: d.n,
    interpretation: d.interpretation,
  }));

  // ── coincident-deviation flags within the current period ────────────────
  // A day where ≥ 2 vitals sat outside their prior-period band together. Uses
  // the same prior-period bands the transitions rest on, so the framing and
  // the COINCIDENT_FIRE_THRESHOLD posture match the live flag.
  const coincidentFlags = computeCoincidentFlags(
    seriesByMetric,
    currentFrom,
    priorFrom,
  );

  const metrics = Array.from(
    new Set([
      ...metricsWithCoverage,
      ...bandTransitions.map((b) => b.type),
      ...drivers.flatMap((d) => [d.behaviour, d.outcome]),
    ]),
  );

  return {
    status: "ready",
    period,
    metricDeltas,
    bandTransitions,
    drivers,
    coincidentFlags,
    pairsTested: discovery.pairsTested,
    fdrQ: discovery.fdrQ,
    provenance: { metrics, window, computedAt },
  };
}

/** ≥ this many out-of-band vitals on one day fires a coincident flag. */
const COINCIDENT_FIRE_THRESHOLD = 2;

/**
 * Scan each day in the current period for ≥ 2 vitals outside their
 * prior-period band. Pure. The band is rebuilt per vital from the prior
 * period (same MAD basis as the transitions), so the two beats agree.
 */
function computeCoincidentFlags(
  seriesByMetric: Map<string, DailySeriesPoint[]>,
  currentFrom: string,
  priorFrom: string,
): CoincidentFlag[] {
  // Build a prior-period band per banded vital, plus the current-period
  // per-day value for each.
  const bands = new Map<string, { low: number; high: number }>();
  const currentByDay = new Map<
    string,
    Array<{ type: MeasurementType; value: number }>
  >();
  for (const type of VITALS_BASELINE_TYPES) {
    const points = seriesByMetric.get(type) ?? [];
    const prior: number[] = [];
    for (const p of points) {
      if (p.day >= currentFrom) {
        const list = currentByDay.get(p.day) ?? [];
        list.push({ type, value: p.value });
        currentByDay.set(p.day, list);
      } else if (p.day >= priorFrom) {
        prior.push(p.value);
      }
    }
    if (prior.length < MIN_BASELINE_DAYS) continue;
    const band = buildBaselineBand(prior, type);
    if (band) bands.set(type, { low: band.low, high: band.high });
  }

  const flags: CoincidentFlag[] = [];
  for (const [day, readings] of [...currentByDay.entries()].sort((a, b) =>
    a[0] < b[0] ? -1 : 1,
  )) {
    const contributing: Array<{
      type: MeasurementType;
      direction: "above" | "below";
    }> = [];
    for (const { type, value } of readings) {
      const band = bands.get(type);
      if (!band) continue;
      if (value > band.high) contributing.push({ type, direction: "above" });
      else if (value < band.low)
        contributing.push({ type, direction: "below" });
    }
    if (contributing.length >= COINCIDENT_FIRE_THRESHOLD) {
      flags.push({ day, vitals: contributing });
    }
  }
  return flags;
}

// ── DB wrapper ─────────────────────────────────────────────────────────────

export interface BuildPeriodNarrativeContextOpts {
  period: NarrativePeriod;
  /** Injected clock for deterministic behaviour; defaults to now. */
  now?: Date;
  /**
   * The reader's locale, for the drivers' narrated `interpretation`. Required:
   * those are finished sentences that reach the prompt and the deterministic
   * fallback, and both callers already know which language the narrative is
   * being written in. An optional locale here would mean an English driver line
   * inside a German summary whenever a caller stayed quiet.
   */
  locale: Locale;
}

/**
 * Fetch + day-key + assemble. Reads a single bounded window covering the
 * current AND prior period (2× the period length plus one extra day so the
 * day-1 lag join in discovery has its source), day-keys in the user's tz,
 * and delegates to the pure core. No LLM, no migration — every read is the
 * shared assembler's, bounded, and the delta / band beats ride the same
 * measurement query as the discovery channels.
 *
 * A note on what the `week` period can produce: its window is 15 days, and
 * `discoverCorrelations` needs 20 lag-joined pairs before it will test one, so
 * a weekly narrative's `drivers` list is empty by arithmetic, not by data.
 * That predates this file's current shape and is left as it is; the deltas,
 * band transitions and coincident flags are what a weekly narrative rests on.
 */
export async function buildPeriodNarrativeContext(
  userId: string,
  opts: BuildPeriodNarrativeContextOpts,
): Promise<PeriodNarrativeResult> {
  const period = opts.period;
  const now = opts.now ?? new Date();
  const periodDays = PERIOD_DAYS[period];
  // +1 day of slack so discovery's day-1 lag join always has its prior day.
  const windowDays = periodDays * 2 + 1;
  const since = new Date(now.getTime() - windowDays * MS_PER_DAY);

  const profile = await prisma.user.findUnique({
    where: { id: userId },
    select: { timezone: true, unitPreference: true, glucoseUnit: true },
  });
  const tz = profile?.timezone ?? DEFAULT_TIMEZONE;
  const units = resolveUnitPreferences({
    unitPreference: profile?.unitPreference,
    glucoseUnit: profile?.glucoseUnit,
  });

  const currentFrom = tzDayKey(
    new Date(now.getTime() - periodDays * MS_PER_DAY),
    tz,
  );
  const priorFrom = tzDayKey(
    new Date(now.getTime() - periodDays * 2 * MS_PER_DAY),
    tz,
  );

  // One read for both jobs. The discovery channels come from the shared
  // assembler; `extraMeasurementTypes` widens the SAME measurement query with
  // the types only this surface's other beats need (the period deltas and the
  // banded vitals), so the delta beat costs no second round-trip.
  //
  // v1.30.3 — the fetch + desc/cap/resort discipline AND the
  // per-type grain resolution (source-collapse sum for cumulative types,
  // per-night reconstruction for sleep — not a blind per-row MEAN) live in
  // `correlation-channel-series.ts`, which the assembler reads through. Before
  // that fix the local `toDailyMeans` twin folded EVERY type through a blind
  // per-row mean: a month's current-vs-prior comparison for `SLEEP_DURATION`
  // averaged per-stage segment durations (~45 min) instead of summing a
  // night's total time asleep, and `ACTIVITY_STEPS` blended per-sample chunk
  // means with drained daily totals — and the `asc, take 20000` cap dropped
  // the CURRENT period first on a dense account, the worst possible direction
  // for a current-vs-prior surface.
  const {
    series: discoverySeries,
    byMetric: seriesByMetric,
    diagnostics,
  } = await assembleDiscoveryMatrix(userId, {
    tz,
    since,
    fetchMode: "raw",
    // Switched-off modules are left out of the scan AND of `byMetric`, so the
    // narrative never cites a delta or a pattern from a module that is off.
    modules: await resolveModuleMap(userId),
    // The one surface that admits RATED mood factors — see the option's doc
    // comment for why it is one and not four.
    includeMoodFactors: true,
    extraMeasurementTypes: Array.from(
      new Set<MeasurementType>([...DELTA_METRICS, ...VITALS_BASELINE_TYPES]),
    ),
  });

  // Surfaces when a dense account's window exceeded the read cap,
  // mirroring the route's identical annotation. The cap now falls on the
  // OLDEST rows (desc + take), so a capped read still covers the CURRENT
  // period this current-vs-prior surface needs.
  annotate({
    action: { name: "insights.period-narrative.read" },
    meta: {
      period,
      measurements_capped: diagnostics.measurementsCapped,
      mood_entries_capped: diagnostics.moodCapped,
      mood_factor_channels: diagnostics.moodFactorChannels,
    },
  });

  return assemblePeriodNarrativeContext({
    period,
    currentFrom,
    priorFrom,
    window: { from: since.toISOString(), to: now.toISOString() },
    seriesByMetric,
    discoverySeries,
    locale: opts.locale,
    computedAt: now.toISOString(),
    units,
  });
}
