/**
 * v1.22 — in-repo changepoint engine over DAY-bucket means.
 *
 * Replaces the vague "lately" with a dated, sustained LEVEL SHIFT:
 * "your resting heart rate stepped up around <date> and has held higher since".
 * This catches the clinically meaningful "changed-and-stayed" pattern a moving
 * trend line hides.
 *
 * The statistic is a single binary-segmentation / CUSUM-on-the-mean pass — no
 * PELT package, no new dependency (CONCEPT-3 §C1 prefers ~80 lines in-repo over
 * a vector/stats lib). We compute the cumulative deviation from the series mean,
 * take the index of maximum |CUSUM| as the candidate break, then VALIDATE the
 * split with a high firing bar so the detector never cries wolf on a spike:
 *
 *   - both segments must be long enough (a real regime, not an endpoint blip),
 *   - the post-break level must PERSIST (≥ `minPersistDays` after the break),
 *   - the level change must exceed the metric's own robust spread
 *     (|Δmean| ≥ `magnitudeK` · MAD · 1.4826), the personal yardstick, and
 *   - the series must be long enough overall,
 *   - the step must explain the series better than a straight line does
 *     (a slow drift splits into two halves with different means, but it is a
 *     drift, not a shift), and
 *   - with the per-metric floors the scan passes ({@link CHANGEPOINT_FLOORS}):
 *     the step must reach a minimum absolute size, and the spread it is
 *     measured against never drops below the device / clinical resolution,
 *     so a device that reports in 0.3 steps cannot make a 0.3 plateau change
 *     look like a many-sigma event.
 *
 * `magnitude` is capped at {@link MAX_MAGNITUDE} so the cross-metric ranking
 * is not won by whichever series happens to be the flattest.
 *
 * Below the bar the detector emits `null` and the Coach keeps saying "lately".
 * One changepoint per metric per window — no multi-break hunting in v1.22.
 *
 * The detector itself is PURE (`detectLevelShift` over `number[]`); the reader
 * (`buildChangepointSignals`) wraps it over the rollup tier for a small set of
 * stable metrics and maps the break index back to a calendar day.
 */
import type { MeasurementType } from "@/generated/prisma/client";
import { probeRollupCoverage } from "@/lib/rollups/measurement-coverage";
import { readDayMeanSeries } from "@/lib/insights/derived/baseline";
import { moduleForMeasurementType } from "@/lib/modules/measurement-scope";
import type { SurfaceModuleMap } from "@/lib/modules/surface";
import { linearFit } from "@/lib/stats/linear-fit";
import { mean, medianAbsoluteDeviation } from "@/lib/stats/central";

const MAD_TO_SIGMA = 1.4826;
/** Upper bound of the reported (and ranked) magnitude, in robust-σ units. */
export const MAX_MAGNITUDE = 10;

/** A validated level shift in a numeric series. */
export interface LevelShift {
  /** Index of the LAST point of the BEFORE segment (the break sits after it). */
  breakIndex: number;
  beforeMean: number;
  afterMean: number;
  /** Signed afterMean − beforeMean. */
  delta: number;
  /** |delta| expressed in robust-σ units (delta / (MAD·1.4826)). */
  magnitude: number;
  direction: "up" | "down";
}

export interface DetectLevelShiftOptions {
  /** Minimum total points before the detector will fire. Default 14. */
  minSeriesLength?: number;
  /** Minimum points in EACH segment. Default 5. */
  minSegmentLength?: number;
  /** Minimum points AFTER the break (persistence). Default 10. */
  minPersistDays?: number;
  /** |Δmean| floor in robust-σ units. Default 1.4 (high firing bar). */
  magnitudeK?: number;
  /** |Δmean| floor in the metric's own unit. Default 0 (none). */
  minAbsDelta?: number;
  /** Lower bound of the pooled spread, in the metric's unit. Default 0. */
  spreadFloor?: number;
}

/** Robust spread: MAD·1.4826 (σ-equivalent). Zero when the series is flat. */
function robustSpread(xs: readonly number[]): number {
  return (medianAbsoluteDeviation(xs) ?? 0) * MAD_TO_SIGMA;
}

/**
 * Detect a single sustained level shift in a numeric series via CUSUM on the
 * mean + a two-segment validation against a high firing bar. Returns `null`
 * when nothing clears the bar (the common case — most series are flat or noisy,
 * not stepped).
 */
export function detectLevelShift(
  series: readonly number[],
  opts: DetectLevelShiftOptions = {},
): LevelShift | null {
  const minSeriesLength = opts.minSeriesLength ?? 14;
  const minSegmentLength = opts.minSegmentLength ?? 5;
  const minPersistDays = opts.minPersistDays ?? 10;
  const magnitudeK = opts.magnitudeK ?? 1.4;
  const minAbsDelta = opts.minAbsDelta ?? 0;
  const spreadFloor = opts.spreadFloor ?? 0;

  const n = series.length;
  if (n < minSeriesLength) return null;

  // CUSUM of deviations from the grand mean; the break candidate is the index
  // where the cumulative deviation is most extreme (the classic CUSUM peak).
  const grand = mean(series)!;
  let cusum = 0;
  let bestAbs = -1;
  let breakIndex = -1;
  for (let i = 0; i < n; i += 1) {
    cusum += series[i] - grand;
    const abs = Math.abs(cusum);
    if (abs > bestAbs) {
      bestAbs = abs;
      breakIndex = i;
    }
  }
  if (breakIndex < 0) return null;

  // Segment guards: both sides long enough + the after-side persists.
  const before = series.slice(0, breakIndex + 1);
  const after = series.slice(breakIndex + 1);
  if (
    before.length < minSegmentLength ||
    after.length < minSegmentLength ||
    after.length < minPersistDays
  ) {
    return null;
  }

  const beforeMean = mean(before)!;
  const afterMean = mean(after)!;
  const delta = afterMean - beforeMean;
  if (Math.abs(delta) < minAbsDelta) return null;

  // Magnitude bar: the step must exceed the WITHIN-segment robust spread (the
  // metric's day-to-day noise), NOT the whole-series spread — a clean step
  // inflates the whole-series MAD and would mask itself. Pool conservatively
  // (the noisier segment). A genuinely clean step (both segments constant) has
  // pooled spread 0; a tiny epsilon lets a non-zero delta fire while a flat
  // series (delta 0) still yields magnitude 0 → null.
  const pooledSpread = Math.max(
    robustSpread(before),
    robustSpread(after),
    spreadFloor,
    1e-9,
  );
  const magnitude = Math.abs(delta) / pooledSpread;
  if (magnitude < magnitudeK) return null;
  if (isDrift(series, before, after, beforeMean, afterMean)) return null;

  return {
    breakIndex,
    beforeMean,
    afterMean,
    delta,
    magnitude: Math.min(magnitude, MAX_MAGNITUDE),
    direction: delta >= 0 ? "up" : "down",
  };
}

/**
 * Every validated level shift in a series, by binary segmentation: find one
 * with {@link detectLevelShift}, then look again on each side of it with the
 * same bar, floors and drift rejection. `breakIndex` is into `series`.
 * Callers that want one dated shift per metric use `detectLevelShift`; this
 * is for a reader that lists several (the MCP changepoint tool).
 */
export function detectLevelShifts(
  series: readonly number[],
  opts: DetectLevelShiftOptions = {},
): LevelShift[] {
  const out: LevelShift[] = [];
  const walk = (lo: number, hi: number) => {
    const shift = detectLevelShift(series.slice(lo, hi), opts);
    if (!shift) return;
    const split = lo + shift.breakIndex + 1;
    out.push({ ...shift, breakIndex: split - 1 });
    walk(lo, split);
    walk(split, hi);
  };
  walk(0, series.length);
  return out;
}

/**
 * True when a straight line through the whole series fits at least as well as
 * the two-level step (same parameter count, so the residual sums compare
 * directly). A drift is then the honest reading, not a dated shift.
 */
function isDrift(
  series: readonly number[],
  before: readonly number[],
  after: readonly number[],
  beforeMean: number,
  afterMean: number,
): boolean {
  let sseStep = 0;
  for (const x of before) sseStep += (x - beforeMean) ** 2;
  for (const x of after) sseStep += (x - afterMean) ** 2;

  const fit = linearFit(
    series.map((_, i) => i),
    series,
  );
  if (!fit) return false;
  // Residual sum of the line from the centred sums: SSR = Syy − Sxy² / Sxx.
  const sseLine = Math.max(0, fit.syy - (fit.sxy * fit.sxy) / fit.sxx);
  return sseLine <= sseStep;
}

/** One detected changepoint, ready for the snapshot. */
export interface ChangepointSignal {
  metric: MeasurementType;
  /** YYYY-MM-DD of the first day of the AFTER segment (the dated step). */
  breakDate: string;
  beforeMean: number;
  afterMean: number;
  direction: "up" | "down";
  /** |Δmean| in robust-σ units, rounded to 1dp (the model never cites it). */
  magnitude: number;
}

/**
 * The stable metrics the changepoint reader scans. Deliberately small — the
 * "changed-and-stayed" question is meaningful for these vitals; the noisy
 * activity/audio series are excluded to keep the firing bar honest.
 */
const CHANGEPOINT_METRICS: readonly MeasurementType[] = [
  "RESTING_HEART_RATE",
  "HEART_RATE_VARIABILITY",
  "WEIGHT",
  "BLOOD_PRESSURE_SYS",
  "BLOOD_GLUCOSE",
];

/**
 * Per-metric floors, in the metric's stored unit: `minDelta` is the smallest
 * level change worth calling a shift (about the smallest change a clinician
 * would note for that vital), `spreadFloor` the smallest day-to-day spread the
 * step is measured against (about the measurement resolution / repeat error of
 * a consumer device). A metric without an entry has neither floor.
 *
 *  - heart rates (bpm): a 3 bpm change, 1 bpm resolution.
 *  - HRV (ms): 5 ms, 2 ms (beat detection jitter).
 *  - weight (kg): 1 kg, 0.2 kg (scale repeat error).
 *  - blood pressure (mmHg): 5 / 3 mmHg, 2 mmHg (cuff repeat error).
 *  - glucose (mg/dL): 10 mg/dL, 3 mg/dL (meter accuracy).
 *  - body fat (%): 1 point, 0.3 point (impedance repeat error).
 *  - respiratory rate (breaths/min): 1, 0.3.
 *  - SpO₂ (%): 1 point, 0.5 point (reported in whole percent).
 *  - VO₂ max (ml/kg/min): 1.5, 0.5 (a modelled estimate that moves in 0.1–0.3
 *    steps; a plateau stepping by 0.3 is the estimator, not the person).
 */
export const CHANGEPOINT_FLOORS: Partial<
  Record<MeasurementType, { minDelta: number; spreadFloor: number }>
> = {
  RESTING_HEART_RATE: { minDelta: 3, spreadFloor: 1 },
  PULSE: { minDelta: 3, spreadFloor: 1 },
  WALKING_HEART_RATE_AVERAGE: { minDelta: 3, spreadFloor: 1 },
  HEART_RATE_VARIABILITY: { minDelta: 5, spreadFloor: 2 },
  HRV_RMSSD: { minDelta: 5, spreadFloor: 2 },
  WEIGHT: { minDelta: 1, spreadFloor: 0.2 },
  BLOOD_PRESSURE_SYS: { minDelta: 5, spreadFloor: 2 },
  BLOOD_PRESSURE_DIA: { minDelta: 3, spreadFloor: 2 },
  BLOOD_GLUCOSE: { minDelta: 10, spreadFloor: 3 },
  BODY_FAT: { minDelta: 1, spreadFloor: 0.3 },
  RESPIRATORY_RATE: { minDelta: 1, spreadFloor: 0.3 },
  OXYGEN_SATURATION: { minDelta: 1, spreadFloor: 0.5 },
  VO2_MAX: { minDelta: 1.5, spreadFloor: 0.5 },
};

/** The {@link CHANGEPOINT_FLOORS} of a metric as detector options. */
export function levelShiftFloors(
  metric: MeasurementType,
): Pick<DetectLevelShiftOptions, "minAbsDelta" | "spreadFloor"> {
  const floors = CHANGEPOINT_FLOORS[metric];
  return {
    minAbsDelta: floors?.minDelta,
    spreadFloor: floors?.spreadFloor,
  };
}

/** Window the reader looks back over (days). */
export const CHANGEPOINT_WINDOW_DAYS = 90;
/** At most this many changepoints in one snapshot (strongest first). */
const MAX_CHANGEPOINTS = 2;

const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * v1.44 — the metrics the health-status surface scans: the five above plus
 * every other vital with a stable daily level and enough readings to carry a
 * 180-day window. Activity volumes, audio and sleep stay out: the first two are
 * day-to-day behaviour rather than a level, and a sleep "day mean" over stage
 * rows is not a night. Wrist temperature stays out for the same privacy reason
 * it is not a correlation channel.
 */
export const EXTENDED_CHANGEPOINT_METRICS: readonly MeasurementType[] = [
  ...CHANGEPOINT_METRICS,
  "HRV_RMSSD",
  "BLOOD_PRESSURE_DIA",
  "PULSE",
  "BODY_FAT",
  "RESPIRATORY_RATE",
  "OXYGEN_SATURATION",
  "WALKING_HEART_RATE_AVERAGE",
  "VO2_MAX",
];

/** Window of the extended scan (days). */
export const EXTENDED_CHANGEPOINT_WINDOW_DAYS = 180;
/** At most this many shifts on the health-status surface. */
const MAX_EXTENDED_CHANGEPOINTS = 5;

/** A changepoint with the day counts of the two segments it compares. */
export interface ExtendedChangepointSignal extends ChangepointSignal {
  /** Days with a value before the break. */
  beforeDays: number;
  /** Days with a value from the break on. */
  afterDays: number;
}

/**
 * Scan a metric set for one validated shift each, fault-isolated per metric,
 * strongest first, capped. One per-day read per metric (DAY rollups, or the
 * per-day SQL fold for a window past the DAY tier), never raw readings in
 * process, so the cost is a row per day per metric whatever the density.
 */
async function scanChangepoints(
  userId: string,
  now: Date,
  metrics: readonly MeasurementType[],
  windowDays: number,
  max: number,
): Promise<ExtendedChangepointSignal[]> {
  const coverage = await probeRollupCoverage(userId);
  const found: ExtendedChangepointSignal[] = [];

  for (const metric of metrics) {
    try {
      const { points } = await readDayMeanSeries(
        userId,
        metric,
        windowDays,
        now,
        coverage,
      );
      if (points.length === 0) continue;
      const shift = detectLevelShift(
        points.map((p) => p.mean),
        levelShiftFloors(metric),
      );
      if (!shift) continue;
      const breakDate =
        points[shift.breakIndex + 1]?.day ?? points[shift.breakIndex].day;
      found.push({
        metric,
        breakDate,
        beforeMean: round1(shift.beforeMean),
        afterMean: round1(shift.afterMean),
        direction: shift.direction,
        magnitude: round1(shift.magnitude),
        beforeDays: shift.breakIndex + 1,
        afterDays: points.length - shift.breakIndex - 1,
      });
    } catch {
      // Fault-isolated — skip this metric, keep scanning.
    }
  }

  found.sort((a, b) => b.magnitude - a.magnitude);
  return found.slice(0, max);
}

/**
 * v1.44 — the health-status scan: {@link EXTENDED_CHANGEPOINT_METRICS} over
 * {@link EXTENDED_CHANGEPOINT_WINDOW_DAYS} days, a metric whose module is off
 * left unread. The Coach keeps {@link buildChangepointSignals}: what reaches a
 * model is not widened by this.
 */
export async function buildExtendedChangepointSignals(
  userId: string,
  now: Date,
  modules: SurfaceModuleMap,
): Promise<ExtendedChangepointSignal[]> {
  const metrics = EXTENDED_CHANGEPOINT_METRICS.filter((metric) => {
    const owner = moduleForMeasurementType(metric);
    return owner === null || modules[owner] !== false;
  });
  return scanChangepoints(
    userId,
    now,
    metrics,
    EXTENDED_CHANGEPOINT_WINDOW_DAYS,
    MAX_EXTENDED_CHANGEPOINTS,
  );
}

/**
 * Read the DAY-mean series for a small set of stable metrics and surface any
 * validated level shift. Best-effort + fault-isolated per metric: a read
 * failure on one metric never sinks the others. Returns the strongest
 * changepoints (by magnitude), capped, or an empty array when nothing fires.
 */
export async function buildChangepointSignals(
  userId: string,
  now: Date = new Date(),
): Promise<ChangepointSignal[]> {
  const found = await scanChangepoints(
    userId,
    now,
    CHANGEPOINT_METRICS,
    CHANGEPOINT_WINDOW_DAYS,
    MAX_CHANGEPOINTS,
  );
  // The Coach snapshot's shape is unchanged: no segment day counts.
  return found.map((signal) => ({
    metric: signal.metric,
    breakDate: signal.breakDate,
    beforeMean: signal.beforeMean,
    afterMean: signal.afterMean,
    direction: signal.direction,
    magnitude: signal.magnitude,
  }));
}
