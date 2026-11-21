/**
 * Plain TypeScript input/output contracts for the cycle prediction + phase
 * engine.
 *
 * These interfaces deliberately do NOT depend on Prisma row types. The engine
 * is a pure, deterministic, DB-free function set: it takes the canonical inputs
 * the iOS device also holds in its local mirror and returns the same struct iOS
 * computes offline. Keeping the inputs as plain shapes (a) makes the engine
 * unit-testable without a database and (b) makes the parity contract with the
 * Swift re-implementation explicit — these fixtures are what iOS reuses.
 *
 * The literal union types below mirror the Prisma enums (FlowLevel,
 * OvulationTest, CervicalMucus, CyclePhase, PredictionMethod, CycleTrackingGoal)
 * named in data-model-ux.md, but are declared locally so the engine never
 * imports the generated client.
 */

/* ------------------------------------------------------------------ */
/* Literal union types (mirror the Prisma enums)                      */
/* ------------------------------------------------------------------ */

export type FlowLevel = "NONE" | "SPOTTING" | "LIGHT" | "MEDIUM" | "HEAVY";

export type OvulationTest =
  "NEGATIVE" | "POSITIVE_LH_SURGE" | "ESTROGEN_SURGE" | "INDETERMINATE";

export type CervicalMucus =
  "DRY" | "STICKY" | "CREAMY" | "WATERY" | "EGG_WHITE";

/**
 * Which symptothermal SECONDARY sign pairs with the temperature primary sign
 * for the Sensiplan double-check. `MUCUS` (cervical-mucus quality) is the
 * default; `CERVIX` swaps in the cervix observation.
 */
export type SecondarySymptom = "MUCUS" | "CERVIX";

/** Mirrors the Prisma enum `CycleReproductiveState`. */
export type CycleReproductiveState = "PREGNANT" | "POSTPARTUM";

/** Cervix vertical position — fertile = HIGH, infertile = LOW. */
export type CervixPosition = "LOW" | "HIGH";

/** Cervix firmness — fertile = SOFT, infertile = FIRM. */
export type CervixFirmness = "FIRM" | "SOFT";

/** Cervix os / opening — fertile = OPEN, infertile = CLOSED. */
export type CervixOpening = "CLOSED" | "OPEN";

export type CyclePhase = "MENSTRUAL" | "FOLLICULAR" | "OVULATORY" | "LUTEAL";

export type PredictionMethod =
  "CALENDAR" | "SYMPTOTHERMAL" | "TEMPERATURE_TREND" | "BLENDED";

export type CycleTrackingGoal =
  | "GENERAL_HEALTH"
  | "AVOID_PREGNANCY"
  | "TRYING_TO_CONCEIVE"
  | "PERIMENOPAUSE"
  | "OFF";

/** Coarse confidence label derived from the scalar (for badge/copy). */
export type ConfidenceLabel = "low" | "medium" | "high";

/* ------------------------------------------------------------------ */
/* Pinned constants (algorithm.md §1–§5, the parity substrate)        */
/* ------------------------------------------------------------------ */

/** §1 — at most the 12 most recent COMPLETED cycles feed the length estimator. */
export const HISTORY_WINDOW_N = 12;

/** §1 — need ≥2 completed cycles for a real (non-priors) prediction. */
export const MIN_CYCLES_TO_PREDICT = 2;

/** §1 — floor on the robust SD so the band is never zero-width (false precision). */
export const SIGMA_FLOOR = 1.0;

/** §1 — normal-consistency constant for MAD → SD (sigma = 1.4826 * MAD). */
export const MAD_NORMAL_CONST = 1.4826;

/** §3 — one-sigma (~68%) band multiplier. Deliberately NOT 1.96. */
export const Z_BAND = 1.0;

/** §3 — date-band half-width clamp (days); never zero, never absurd. */
export const HALF_WIDTH_MIN = 1;
export const HALF_WIDTH_MAX = 14;

/** §5 — fixed half-width (days) for the 0-cycle priors-only path. */
export const PRIORS_ONLY_HALF_WIDTH = 4;

/** §5 — extra half-width (days) added on the single-cycle cold-start path. */
export const COLD_START_BAND_BONUS = 3;

/** §2 — last 6 cycles feed the period-length estimator. */
export const PERIOD_WINDOW_N = 6;

/** §5 — population fallbacks when the user has no data and no prior. */
export const POPULATION_DEFAULT_CYCLE = 28;
export const POPULATION_DEFAULT_PERIOD = 5;

/** §2 — period-length clamp (days). */
export const PERIOD_MIN = 1;
export const PERIOD_MAX = 10;

/** §4 — luteal-phase length default + physiological clamp. */
export const LUTEAL_DEFAULT = 14;
export const LUTEAL_MIN = 10;
export const LUTEAL_MAX = 16;

/**
 * §4 — the fertile window: ovulation − 5 … ovulation + 1, seven days.
 *
 * Wilcox's six-day window is the five days BEFORE ovulation plus the day
 * itself, and the trailing day here is a deliberate departure from it. The
 * six-day figure is measured against a KNOWN ovulation day; ours is estimated,
 * usually by back-calculating a luteal length from a median cycle, and an
 * estimate that lands a day early would put the last fertile day outside a
 * window drawn tight to it. The ovum also stays viable for the better part of a
 * day after release, so the extra day is not only estimator slack.
 *
 * The asymmetry of the cost decides the direction. This window is surfaced to
 * people trying to conceive and to people avoiding it, and for the second group
 * a window one day too short is a window that misses. The constants are the
 * conservative reading; the comment used to claim six days and describe seven,
 * which is the only part of this that was wrong.
 *
 * Changing either constant changes what the iOS client reimplements from the
 * same spec, so it needs a coordination note, not just an edit here.
 */
export const FERTILE_PRE = 5;
export const FERTILE_POST = 1;

/** §5 — robust MAD-fence multiplier (3-MAD normal, 4-MAD perimenopause). */
export const OUTLIER_K = 3.0;
export const OUTLIER_K_PERIMENOPAUSE = 4.0;

/**
 * §5 — hard physiological cycle-length bounds (always outlier candidates).
 *
 * The ceiling is a deliberately generous outlier *backstop*, not a clinical
 * "normal" cap — the robust MAD fence + missed-log heuristic do the real
 * outlier work. ACOG flags cycles > 35 d as oligomenorrhea, but such cycles are
 * still genuine, and adolescents / perimenopausal users routinely run to ~50+ d.
 * A hard cap of 45 force-excluded those legitimate long cycles, biasing the
 * estimate toward the population middle for exactly the irregular users who most
 * need an honest estimate. 60 d keeps the rare gross-error guard (a length this
 * long is almost always a missed log, which the missed-log rule also catches)
 * while letting real long cycles reach the MAD fence. The MAD fence is
 * computed pre-exclusion, so raising the ceiling does not move the fence — it
 * only stops the hard rule from pre-empting it on long but consistent cycles.
 */
export const HARD_CYCLE_MIN = 21;
export const HARD_CYCLE_MAX = 60;

/** §5 — a single length ≥ this × median is treated as a probable missed-log. */
export const MISSED_LOG_FACTOR = 1.75;

/** §4 — symptothermal (manual BBT) "third measurement" rise threshold (°C). */
export const TEMP_SHIFT_C_MANUAL = 0.2;

/** §4 — passive wrist/skin temperature-trend deviation threshold (°C). */
export const TEMP_SHIFT_C_PASSIVE = 0.15;

/** §4 — half-width multipliers when ovulation is confirmed by each layer. */
export const HALF_WIDTH_MULT_SYMPTOTHERMAL = 0.6;
export const HALF_WIDTH_MULT_TEMP_TREND = 0.75;

/** §4 — symptothermal agreement tolerance between temp-shift and mucus peak (days). */
export const SYMPTOTHERMAL_AGREE_DAYS = 2;

/**
 * §4 — Marquette (Fehring) LH/OPK ovulation lag. A positive urinary-LH surge
 * precedes ovulation by ~24–36 h, so ovulation is estimated one day after the
 * (last) positive LH test. Used to ANCHOR — never to confirm — the ovulation
 * estimate: a single LH indicator is not the symptothermal double-check, so it
 * sharpens the estimate without asserting confirmed ovulation.
 *
 * Citation: Fehring R.J. — Marquette Method; urinary LH peaks ~1 day before
 * ovulation. ESHRE/Wilcox fertile-window literature.
 */
export const LH_SURGE_TO_OVULATION_DAYS = 1;

/**
 * §4 — trailing lookback (days) for the symptothermal / temperature-trend
 * detectors. The 3-over-6 BBT rule needs 6 baseline readings before the rise,
 * so a current-cycle scan starting at lastConfirmedStart must reach back this
 * far to keep the baseline window intact when the cycle is still young. Also
 * the floor for windowing the day-log read on the hot calendar/insights routes.
 */
export const BBT_WINDOW = 40;

/** §3 — confidence scalar clamp (never certain, never zero). */
export const CONFIDENCE_MIN = 0.05;
export const CONFIDENCE_MAX = 0.98;

/** §3 — confidence → label cut points. */
export const CONFIDENCE_LABEL_LOW_MAX = 0.4; // < 0.40 → low
export const CONFIDENCE_LABEL_HIGH_MIN = 0.7; // > 0.70 → high

/** §3 — c_adherence floor + slope (0.4 + 0.6 * density). */
export const ADHERENCE_FLOOR = 0.4;
export const ADHERENCE_SLOPE = 0.6;

/** §3 — max band widening from sparse logging (LOG_SPARSITY scale). */
export const LOG_SPARSITY_SCALE = 0.5;

/* ------------------------------------------------------------------ */
/* Input contracts                                                    */
/* ------------------------------------------------------------------ */

/**
 * One confirmed (or predicted) cycle. `startDate` is the first bleeding day.
 * The engine treats a cycle as COMPLETED only when a later cycle's `startDate`
 * exists, giving it a known length.
 */
export interface CycleInput {
  /** First bleeding day of the menstruation, `YYYY-MM-DD`. */
  startDate: string;
  /** First bleeding day of the NEXT cycle, or null if this is the latest. */
  endDate: string | null;
  /** Last bleeding day of THIS cycle's period run, or null if unknown. */
  periodEndDate: string | null;
  /** Confirmed/estimated ovulation day, or null. */
  ovulationDate: string | null;
  /** Whether `ovulationDate` was confirmed (symptothermal/temp), not estimated. */
  ovulationConfirmed: boolean;
}

/** One day's observations (the HealthKit / manual sync unit). */
export interface DayLogInput {
  /** The logged day, `YYYY-MM-DD`. */
  date: string;
  flow: FlowLevel | null;
  /** Basal body temperature in °C, already rounded to 2 dp before input. */
  basalBodyTempC: number | null;
  /**
   * Whether this day's BBT is a disturbed/unreliable reading (fever, illness,
   * alcohol, a late or short-sleep measurement) the user marked excluded. When
   * true the engine drops the reading from the cover-line baseline AND the shift
   * evaluation, so a spike neither fabricates nor masks a temperature rise
   * (Sensiplan: the cover line is drawn over the last six *unbracketed* values).
   * Optional for back-compat; treated as `false` when absent.
   */
  temperatureExcluded?: boolean | null;
  ovulationTest: OvulationTest | null;
  cervicalMucus: CervicalMucus | null;
  /**
   * Cervix observation — the three Sensiplan cervix signs. Used as the
   * symptothermal SECONDARY indicator when the profile's `secondarySymptom`
   * is `CERVIX`; ignored on the default (mucus) path. All optional for
   * back-compat; an unobserved sign is `null`/absent.
   */
  cervixPosition?: CervixPosition | null;
  cervixFirmness?: CervixFirmness | null;
  cervixOpening?: CervixOpening | null;
}

/**
 * One nightly passive-temperature deviation reading (Apple Watch wrist /
 * skin temperature), used by the TEMPERATURE_TREND layer. `deviationC` is the
 * nightly value's deviation from the user's own baseline in °C (the engine also
 * accepts a raw nightly value and derives the trailing-mean deviation itself —
 * see prediction.ts).
 */
export interface NightlyTempInput {
  date: string;
  /** Nightly temperature value in °C (raw; baseline derived internally). */
  valueC: number;
}

/** User-set priors + mode flags. All optional; the engine applies defaults. */
export interface CycleProfileInput {
  goal: CycleTrackingGoal;
  typicalCycleLength: number | null;
  typicalPeriodLength: number | null;
  lutealPhaseLength: number | null;
  /** When false the engine emits no prediction (caller checks before calling). */
  predictionEnabled: boolean;
  /** Read-Your-Body mode: suppress all interpretation. */
  rawChartMode: boolean;
  /**
   * Which symptothermal SECONDARY sign the double-check uses — `MUCUS`
   * (default) or `CERVIX`. Optional for back-compat; the engine treats an
   * absent value as `MUCUS`, so existing callers keep the mucus path
   * unchanged.
   */
  secondarySymptom?: SecondarySymptom;
  /**
   * The pregnancy / postpartum state (`src/lib/cycle/pregnancy.ts`).
   * Optional so the engine's own tests and the iOS parity fixtures keep
   * their shape; absent reads as the ordinary cycle. `gatedPrediction`
   * answers null while the resolved state pauses the forecast.
   */
  reproductiveState?: CycleReproductiveState | null;
  pregnancyStartDate?: string | null;
  pregnancyDueDate?: string | null;
  deliveryDate?: string | null;
  postpartumWeeks?: number | null;
}

/* ------------------------------------------------------------------ */
/* Output contracts                                                   */
/* ------------------------------------------------------------------ */

/** The materialised forecast (mirrors the CyclePrediction row). */
export interface CyclePredictionResult {
  method: PredictionMethod;
  /** Point estimate of the next period's first day, `YYYY-MM-DD`. */
  nextPeriodStart: string;
  /** Low end of the one-sigma date band, `YYYY-MM-DD`. */
  nextPeriodStartLow: string;
  /** High end of the one-sigma date band, `YYYY-MM-DD`. */
  nextPeriodStartHigh: string;
  /** Predicted length of the next period bar (days), clamped [1,10]. */
  predictedPeriodLength: number;
  /** Fertile window start (ovulation − 5), or null when goal-gated off upstream. */
  fertileWindowStart: string | null;
  /** Fertile window end (ovulation + 1), or null. */
  fertileWindowEnd: string | null;
  /** Estimated/confirmed ovulation day for the upcoming cycle. */
  predictedOvulation: string | null;
  /** Whether `predictedOvulation` was confirmed by a signal layer. */
  ovulationConfirmed: boolean;
  /** Confidence scalar in [0.05, 0.98]. */
  confidence: number;
  /** Coarse label for the badge/copy. */
  confidenceLabel: ConfidenceLabel;
  /** Completed cycle lengths used (post outlier-exclusion). */
  cyclesObserved: number;
  /** <3 observed cycles → "still learning" UI state, independent of score. */
  stillLearning: boolean;
  /** Estimated typical cycle length (days, rounded). */
  estimatedCycleLength: number;
  /** Robust SD of cycle length (days), >= SIGMA_FLOOR. */
  estimatedCycleSd: number;
}
