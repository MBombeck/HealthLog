/**
 * Client-side illness DTO mirrors (v1.18.1) — the wire shapes the
 * `/api/illness/*` routes return. Kept in lockstep with
 * `src/lib/illness/dto.ts` (the server-authoritative source).
 */
export type IllnessType =
  | "INFECTION"
  | "ALLERGY"
  | "INJURY"
  | "MENTAL_HEALTH"
  | "AUTOIMMUNE"
  | "CHRONIC"
  | "OTHER";

export type IllnessLifecycle =
  "ACUTE" | "CHRONIC_ONGOING" | "RECURRING" | "FLARE";

export interface IllnessSymptomSelection {
  key: string;
  severity?: number | null;
}

export interface IllnessEpisodeDTO {
  id: string;
  label: string;
  type: IllnessType;
  lifecycle: IllnessLifecycle;
  onsetAt: string;
  resolvedAt: string | null;
  parentConditionId: string | null;
  note: string | null;
  /** Where on the body, decrypted; null when not stated (v1.39.2). */
  bodySite: string | null;
  laterality: "LEFT" | "RIGHT" | "BOTH" | null;
  createdAt: string;
  updatedAt: string;
}

export interface IllnessDayLogDTO {
  id: string;
  episodeId: string;
  date: string;
  functionalImpact: number | null;
  feverC: number | null;
  symptoms: IllnessSymptomSelection[];
  note: string | null;
  updatedAt: string;
}

/**
 * v1.18.3 — the date-less day-log LIST response (`GET .../day-logs` with no
 * `date`). Server-authoritative; iOS (healthlog-iOS#30) renders the rows +
 * pages on `meta.total`. Mirrors the Labs list envelope shape.
 */
export interface IllnessDayLogListResponse {
  dayLogs: IllnessDayLogDTO[];
  meta: { total: number; limit: number; offset: number };
}

export interface IllnessEpisodeCreateInput {
  label: string;
  type: IllnessType;
  lifecycle?: IllnessLifecycle;
  onsetAt?: string;
  /** Optional resolved/end instant — set to backdate an already-recovered
   *  episode captured after the fact; omit/null for an ongoing episode. */
  resolvedAt?: string | null;
  parentConditionId?: string | null;
  note?: string | null;
  bodySite?: string | null;
  laterality?: "LEFT" | "RIGHT" | "BOTH" | null;
}

export interface IllnessDayLogInput {
  date: string;
  functionalImpact?: number | null;
  feverC?: number | null;
  symptoms?: IllnessSymptomSelection[];
  note?: string | null;
}

export interface IllnessEpisodeUpdateInput {
  label?: string;
  type?: IllnessType;
  lifecycle?: IllnessLifecycle;
  onsetAt?: string;
  resolvedAt?: string | null;
  parentConditionId?: string | null;
  note?: string | null;
  /** Absent keeps the stored value; null or blank clears it. */
  bodySite?: string | null;
  laterality?: "LEFT" | "RIGHT" | "BOTH" | null;
}

/* ── P3 correlation + retrospective DTOs (server-authoritative) ───────── */

export interface IllnessVitalDeviation {
  type: string;
  day: string;
  value: number;
  baselineCenter: number;
  deviationSd: number;
  direction: "above" | "below";
  adverse: boolean;
}

export interface IllnessVitalReturn {
  /** A `MeasurementType`, or `"FUNCTIONAL_IMPACT"` for the symptom-burden track. */
  type: string;
  returnedDay: string | null;
  gapDays: number | null;
  adverse: boolean;
}

export interface IllnessRedFlag {
  type: string;
  reason: "sustained_low_spo2" | "sustained_fever";
  worstValue: number;
  days: number;
}

/**
 * A neutral sleep-as-context observation for the episode — slept more / less
 * than usual — surfaced ALONGSIDE the gap, never part of the recovery-gap
 * number. Null when the sleep data is too thin or the delta sub-floor.
 */
export interface SleepContext {
  baselineMeanMinutes: number;
  episodeMeanMinutes: number;
  /** `episode − baseline` asleep minutes (positive = slept more than usual). */
  deltaMinutes: number;
  nightsCounted: number;
}

export interface IllnessCorrelationValue {
  episodeId: string;
  preOnset: IllnessVitalDeviation[];
  nadir: IllnessVitalDeviation[];
  returns: IllnessVitalReturn[];
  recoveryGapDays: number | null;
  adverseCoverageDays: number;
  feltBetterDay: string | null;
  /**
   * The metric that drove the headline gap — a `MeasurementType`,
   * `"FUNCTIONAL_IMPACT"` (the symptom-burden track), or null. Drives the
   * driver-aware recovery-gap copy.
   */
  gapDriverType: string | null;
  redFlags: IllnessRedFlag[];
  /**
   * Sleep-as-context observation, or null when withheld (thin data / sub-floor
   * delta). Additive — never part of the headline recovery-gap.
   */
  sleepContext: SleepContext | null;
}

/** The flat `Derived<T>` wire shape the correlation route returns. */
export interface IllnessCorrelationResponse {
  episodeId: string;
  status: "ok" | "insufficient";
  value: IllnessCorrelationValue | null;
  coverage: {
    requiredInputs: number;
    presentInputs: number;
    historyDays: number;
    missing: string[];
  };
  confidence: { score: number; band: string } | null;
  provenance: {
    inputs: string[];
    source: string;
    windowDays: number;
    computedAt: string;
  };
  reason: string | null;
}

export interface IllnessInsightsResponse {
  windowDays: number;
  episodeCount: number;
  resolvedCount: number;
  typicalRecoveryGapDays: number | null;
  gapSampleSize: number;
  byMonth: Record<string, number>;
  byType: Record<string, number>;
  gapDriverType: string | null;
}
