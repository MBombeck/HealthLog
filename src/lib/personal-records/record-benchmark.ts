/**
 * The comparison band published beside a personal record (v1.43, ios #116
 * item 5).
 *
 * The native client used to place a record against hard-coded population
 * values that knew neither the person's age nor their sex. The server owns the
 * cited norms (`lookupNormalRange` in `src/lib/insights/derived/norms.ts`, the
 * Enright & Sherrill equation for the six-minute walk), so it resolves the band
 * here and the clients show it as delivered, or nothing when it is null.
 *
 * The band is for the age the person had when the record was set: a record
 * from ten years ago is compared with what was typical then, not with today's
 * bracket. Null whenever no honest band exists: a metric without a cited norm,
 * no date of birth, a sex the table has no row for, a per-sport workout slot,
 * or a record stored in a unit other than the norm's (the band is never
 * converted on a guess).
 *
 * Pure: the caller reads the profile and the weight the walk equation needs.
 */
import { ageInYears } from "@/lib/tz/date-only";
import type { MeasurementType } from "@/generated/prisma/client";
import {
  lookupNormalRange,
  predictSixMinuteWalkDistance,
  type NormSex,
} from "@/lib/insights/derived/norms";
import type { MetricStatusMetricId } from "@/lib/insights/metric-status-registry";
import { getUnitForType } from "@/lib/measurements/unit-map";

export interface RecordBenchmark {
  low: number;
  high: number;
  unit: string;
  /** Stable identifier of the cited norm. */
  source: string;
  /** The citation as a reader sees it. */
  sourceLabel: string;
}

/** The profile facts the norms are keyed on. */
export interface RecordBenchmarkProfile {
  dateOfBirth: Date | null;
  sex: NormSex;
  heightCm: number | null;
  /** Latest weight in kg, for the six-minute-walk equation only. */
  weightKg: number | null;
  /** The owner's zone: the day their birthday turns over in. */
  timezone: string;
}

interface NormCitation {
  metricId: MetricStatusMetricId;
  source: string;
  sourceLabel: string;
}

const CITED_NORMS: Partial<Record<MeasurementType, NormCitation>> = {
  VO2_MAX: {
    metricId: "VO2_MAX",
    source: "friend_2015",
    sourceLabel: "FRIEND registry (Kaminsky et al. 2015)",
  },
  RESTING_HEART_RATE: {
    metricId: "RESTING_HEART_RATE",
    source: "fleming_2011",
    sourceLabel: "Fleming et al. 2011, AHA",
  },
  RESPIRATORY_RATE: {
    metricId: "RESPIRATORY_RATE",
    source: "who_pals",
    sourceLabel: "WHO / PALS reference",
  },
  GRIP_STRENGTH: {
    metricId: "GRIP_STRENGTH",
    source: "dodds_2014",
    sourceLabel: "Dodds et al. 2014, EWGSOP2",
  },
};

const SIX_MINUTE_WALK: { source: string; sourceLabel: string } = {
  source: "enright_sherrill_1998",
  sourceLabel: "Enright & Sherrill 1998",
};

/**
 * The share of the predicted distance the six-minute-walk card already calls
 * "green" (`six-minute-walk.ts`). The band runs from there to the predicted
 * distance, so the record and the card speak about the same expectation.
 */
const SIX_MINUTE_WALK_LOW_SHARE = 0.8;

/** Spellings of one canonical unit that writers have used. */
const UNIT_ALIASES: Record<string, readonly string[]> = {
  "breaths/min": ["count/min", "/min", "breaths/min", "brpm"],
};

function unitKey(unit: string): string {
  return unit.toLowerCase().replace(/[^a-z0-9%]/g, "");
}

function sameUnit(type: MeasurementType, stored: string): boolean {
  const canonical = getUnitForType(type);
  const accepted = [canonical, ...(UNIT_ALIASES[canonical] ?? [])];
  return accepted.some((u) => unitKey(u) === unitKey(stored));
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function resolveRecordBenchmark(
  record: {
    metricType: MeasurementType;
    metricSlot: string | null;
    unit: string;
    achievedAt: Date;
  },
  profile: RecordBenchmarkProfile,
): RecordBenchmark | null {
  // A per-sport slot (a 5 km time) has no population norm here.
  if (record.metricSlot !== null) return null;
  if (!sameUnit(record.metricType, record.unit)) return null;
  const age = ageInYears(
    profile.dateOfBirth,
    profile.timezone,
    record.achievedAt,
  );
  // Every band below is age-stratified; without an age none is honest.
  if (age === null) return null;

  if (record.metricType === "SIX_MINUTE_WALK_DISTANCE") {
    const predicted = predictSixMinuteWalkDistance(
      age,
      profile.heightCm,
      profile.weightKg,
      profile.sex,
    );
    if (predicted === null) return null;
    return {
      low: Math.round(predicted * SIX_MINUTE_WALK_LOW_SHARE),
      high: Math.round(predicted),
      unit: record.unit,
      ...SIX_MINUTE_WALK,
    };
  }

  const citation = CITED_NORMS[record.metricType];
  if (!citation) return null;
  const band = lookupNormalRange(citation.metricId, age, profile.sex);
  if (!band) return null;
  return {
    low: round1(band.low),
    high: round1(band.high),
    unit: record.unit,
    source: citation.source,
    sourceLabel: citation.sourceLabel,
  };
}

/** Whether a record of this type can carry a band at all (query planning). */
export function mayCarryBenchmark(type: MeasurementType): boolean {
  return type === "SIX_MINUTE_WALK_DISTANCE" || type in CITED_NORMS;
}
