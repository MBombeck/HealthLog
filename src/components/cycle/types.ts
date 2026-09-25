/**
 * v1.15.0 — client-side mirrors of the `/api/cycle/*` response DTOs
 * (ios-contract §2). These match `src/lib/cycle/dto.ts` +
 * `src/lib/cycle/engine-adapter.ts` field-for-field so the read hooks can
 * type the unwrapped `(await res.json()).data`.
 */

export type CyclePhase = "MENSTRUAL" | "FOLLICULAR" | "OVULATORY" | "LUTEAL";

export type FlowLevel = "NONE" | "SPOTTING" | "LIGHT" | "MEDIUM" | "HEAVY";

export type OvulationTest =
  "NEGATIVE" | "POSITIVE_LH_SURGE" | "ESTROGEN_SURGE" | "INDETERMINATE";

export type CervicalMucus =
  "DRY" | "STICKY" | "CREAMY" | "WATERY" | "EGG_WHITE";

export type CycleGoal =
  | "GENERAL_HEALTH"
  | "AVOID_PREGNANCY"
  | "TRYING_TO_CONCEIVE"
  | "PERIMENOPAUSE"
  | "OFF";

export interface CalendarDay {
  date: string;
  phase: CyclePhase | null;
  isPredictedPeriod: boolean;
  isFertileWindow: boolean;
  isPredictedOvulation: boolean;
  isPeriodLogged: boolean;
  /** Whether a logged cycle opens on this day. */
  isCycleStart: boolean;
  /**
   * The 1-based day of the logged cycle this date belongs to, resolved by the
   * server for THIS date (not today). Null when the record cannot say.
   */
  cycleDay: number | null;
  /** Whether the one-tap period end can land on this date. */
  periodEndable: boolean;
  flow: string | null;
  hasSymptoms: boolean;
  confidence: number;
  /** Logged basal body temperature (°C), or null. Feeds the BBT chart. */
  basalBodyTempC: number | null;
  ovulationTest: OvulationTest | null;
  cervicalMucus: CervicalMucus | null;
  /** Logged cervix signs, each or null. */
  cervixPosition: string | null;
  cervixFirmness: string | null;
  cervixOpening: string | null;
  /** Spotting outside the period logged on this day. */
  intermenstrualBleeding: boolean;
  /** Intercourse logged on this day (resolved server-side, envelope included). */
  sexualActivity: boolean;
  pregnancyTest: string | null;
  progesteroneTest: string | null;
  contraceptive: string | null;
  /** Whether the day carries a note; the text is only on the day-log read. */
  hasNote: boolean;
}

export interface CyclePrediction {
  method: string;
  nextPeriodStart: string;
  nextPeriodStartLow: string;
  nextPeriodStartHigh: string;
  fertileWindowStart: string | null;
  fertileWindowEnd: string | null;
  predictedOvulation: string | null;
  ovulationConfirmed: boolean;
  confidence: number;
  cyclesObserved: number;
  stillLearning: boolean;
  disclaimer: string;
}

/**
 * The server's resolved answer about today (`src/lib/cycle/verdict.ts`).
 *
 * Render it. Do not recompute any part of it here: the grace window that
 * decides `OVERDUE`, the day count, the ring's arcs and the fertile-window
 * state are all resolved server-side against the user's own timezone day, and
 * a second copy of that logic in client code is how a cycle ring ends up
 * showing a person a day their record does not hold.
 */
export type CycleVerdictState = "IN_CYCLE" | "OVERDUE" | "INSUFFICIENT_DATA";

export interface CycleVerdict {
  state: CycleVerdictState;
  dayOfCycle: number | null;
  cycleLength: number | null;
  phase: CyclePhase | null;
  spans: { phase: CyclePhase; fraction: number }[];
  cycleStartDate: string | null;
  overdueDays: number | null;
  daysUntilNext: number | null;
  fertileWindow: { start: string | null; end: string | null; active: boolean };
}

export interface CalendarResponse {
  profile: {
    goal: CycleGoal;
    rawChartMode: boolean;
    predictionEnabled: boolean;
    cyclesObserved: number;
  };
  prediction: CyclePrediction | null;
  /** The resolved verdict — always present, so nothing here needs to derive one. */
  verdict: CycleVerdict;
  /**
   * Cold-start gate (mirrors `prediction.stillLearning`): true while < 3 cycles
   * are observed. When set, `days` carries no fertile window, ovulation dot, or
   * phase band — render the calm "learning your cycle" state over the grid.
   */
  stillLearning: boolean;
  days: CalendarDay[];
  meta: { generatedAt: string };
}

export interface MenstrualCycleDTO {
  id: string;
  startDate: string;
  endDate: string | null;
  periodEndDate: string | null;
  lengthDays: number | null;
  ovulationDate: string | null;
  ovulationConfirmed: boolean;
  isPredicted: boolean;
  syncVersion: number;
  updatedAt: string;
}

export interface CycleHistoryResponse {
  cycles: MenstrualCycleDTO[];
  stats: {
    avgLengthDays: number | null;
    lengthVariabilityDays: number | null;
    avgPeriodLengthDays: number | null;
    regularity: "REGULAR" | "IRREGULAR" | "LEARNING";
  };
}

/** Symptothermal secondary symptom — mucus (default) or cervix observation. */
export type SecondarySymptom = "MUCUS" | "CERVIX";

/** The three Sensiplan cervix signs. */
export type CervixPosition = "LOW" | "HIGH";
export type CervixFirmness = "FIRM" | "SOFT";
export type CervixOpening = "CLOSED" | "OPEN";

export interface CycleProfileDTO {
  goal: CycleGoal;
  cycleTrackingEnabled: boolean;
  secondarySymptom: SecondarySymptom;
  rawChartMode: boolean;
  predictionEnabled: boolean;
  discreetNotifications: boolean;
  sensitiveCategoryEncryption: boolean;
  typicalCycleLength: number | null;
  typicalPeriodLength: number | null;
  lutealPhaseLength: number | null;
  updatedAt: string;
}

/** The day-log capture payload (subset of the API input we send from web). */
export type HomeTestResult = "NEGATIVE" | "POSITIVE" | "INDETERMINATE";

export type ContraceptiveKind =
  | "NONE"
  | "UNSPECIFIED"
  | "IMPLANT"
  | "INJECTION"
  | "IUD"
  | "INTRAVAGINAL_RING"
  | "ORAL"
  | "PATCH"
  | "EMERGENCY";

export interface CycleSymptomSelection {
  key: string;
  severity?: number | null;
}

export interface CycleDayLogInput {
  date: string;
  flow?: FlowLevel;
  intermenstrualBleeding?: boolean;
  basalBodyTempC?: number;
  temperatureExcluded?: boolean;
  ovulationTest?: OvulationTest;
  cervicalMucus?: CervicalMucus;
  cervixPosition?: CervixPosition | null;
  cervixFirmness?: CervixFirmness | null;
  cervixOpening?: CervixOpening | null;
  sexualActivity?: boolean;
  protectedSex?: boolean | null;
  pregnancyTest?: HomeTestResult;
  progesteroneTest?: HomeTestResult;
  contraceptive?: ContraceptiveKind;
  symptoms?: CycleSymptomSelection[];
  note?: string;
  loggedAt: string;
  source?: "MANUAL";
}

/** The full day-log row read back from `GET /api/cycle/day-logs?date=`. */
export interface CycleDayLogDTO {
  id: string;
  date: string;
  cycleId: string | null;
  flow: FlowLevel | null;
  intermenstrualBleeding: boolean;
  basalBodyTempC: number | null;
  temperatureExcluded: boolean;
  ovulationTest: OvulationTest | null;
  cervicalMucus: CervicalMucus | null;
  cervixPosition: CervixPosition | null;
  cervixFirmness: CervixFirmness | null;
  cervixOpening: CervixOpening | null;
  sexualActivity: boolean;
  protectedSex: boolean | null;
  pregnancyTest: HomeTestResult | null;
  progesteroneTest: HomeTestResult | null;
  contraceptive: ContraceptiveKind | null;
  symptoms: { key: string; severity: number | null }[];
  note: string | null;
  source: string;
  externalId: string | null;
  syncVersion: number;
  updatedAt: string;
  deletedAt: string | null;
}
