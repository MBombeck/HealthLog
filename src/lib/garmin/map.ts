/**
 * Garmin records to measurement rows: pure functions over the wire shapes
 * (`./wire-types.ts`), no I/O. `__tests__/map.test.ts` pins what each makes
 * of made-up records shaped from Garmin's OpenAPI document.
 *
 * Every row carries its own `externalId`, keyed on the record's calendar day
 * (or the weigh-in's sample id) and a field tag, so a re-read of the same day
 * lands on the same row and Garmin's later re-scoring overwrites in place.
 *
 * What maps where:
 *
 *   daily summary  steps, step distance, floors, active kcal, resting HR,
 *                  average stress level (STRESS_LEVEL), Body Battery high
 *   sleep summary  per-stage minutes (light→CORE, deep, REM, awake) stamped
 *                  on the wake instant, the overall sleep score, the night's
 *                  average SpO2 and breathing rate
 *   HRV            `lastNightAvg` (RMSSD) → HRV_RMSSD; Garmin reports no SDNN
 *   weigh-ins      weight, BMI, body fat, body water, muscle, bone, visceral
 *
 * Masses are kilograms in Garmin's document and grams on the live service,
 * so each is read by magnitude; body water is a percentage of the weigh-in's
 * weight and is converted to the kilograms the type stores.
 */
import { canonicalDailyTimestamp } from "@/lib/measurements/consolidation-tz";
import { importValue } from "@/lib/integrations/import-value";
import { annotate } from "@/lib/logging/context";
import { validateMeasurementRange } from "@/lib/measurements/value-ranges";

import type {
  GarminDailySummary,
  GarminHrvEnvelope,
  GarminInstant,
  GarminSleepSummary,
  GarminWeighIn,
  GarminWeightRangeEnvelope,
} from "./wire-types";

export interface GarminMappedMeasurement {
  type: string;
  value: number;
  unit: string;
  measuredAt: Date;
  externalId: string;
  sleepStage?: "CORE" | "DEEP" | "REM" | "AWAKE";
  deviceType?: "watch" | "scale";
}

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

function isDay(value: unknown): value is string {
  return typeof value === "string" && DAY_KEY.test(value);
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * An instant as Garmin sends it. Epoch ms numbers, or a GMT wall-clock
 * string without a zone (`2026-10-22T05:40:00.0`, `2026-10-22 05:15:02`),
 * which is read as UTC because every field it is used for is a `GMT` one.
 */
export function parseGarminInstant(value: GarminInstant): Date | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value !== "string" || value.trim() === "") return null;
  let text = value.trim().replace(" ", "T");
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(text)) text = `${text}Z`;
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** A date-only record's instant: local noon of its date in the user's zone. */
function dayAnchor(day: string, tz: string | undefined): Date | null {
  const d = canonicalDailyTimestamp(day, tz);
  return Number.isNaN(d.getTime()) ? null : d;
}

function scoreValue(v: number | null): number | null {
  // Garmin marks "not enough data" with negative sentinels (-1, -2).
  if (v === null || v < 0 || v > 100) return null;
  return Math.round(v);
}

/** One day of `v2/dailysummaries`. A day the watch recorded nothing maps to nothing. */
export function mapGarminDailySummary(
  d: GarminDailySummary,
  tz?: string,
): GarminMappedMeasurement[] {
  if (!isDay(d.calendarDate)) return [];
  // A summary exists for every calendar day, worn or not; only a day with
  // wellness data carries readings. Otherwise a year before the first watch
  // would import as a year of zero steps.
  if (d.includesWellnessData !== true) return [];
  const day = d.calendarDate;
  const measuredAt = dayAnchor(day, tz);
  if (!measuredAt) return [];
  const out: GarminMappedMeasurement[] = [];
  const push = (
    type: string,
    value: number | null,
    unit: string,
    tag: string,
  ) => {
    if (value === null) return;
    out.push({
      type,
      value,
      unit,
      measuredAt,
      externalId: `daily:${day}:${tag}`,
      deviceType: "watch",
    });
  };

  const steps = num(d.movement?.steps?.value);
  push(
    "ACTIVITY_STEPS",
    steps !== null && steps >= 0 ? Math.round(steps) : null,
    "steps",
    "steps",
  );
  const distance = num(d.movement?.steps?.distanceInMeters);
  push(
    "WALKING_RUNNING_DISTANCE",
    distance !== null && distance >= 0 ? importValue(distance) : null,
    "m",
    "distance",
  );
  const floors = num(d.movement?.floorsAscended?.value);
  push(
    "FLIGHTS_CLIMBED",
    floors !== null && floors >= 0 ? Math.round(floors) : null,
    "flights",
    "floors",
  );
  const active = num(d.calories?.burnedActive);
  push(
    "ACTIVE_ENERGY_BURNED",
    active !== null && active >= 0 ? importValue(active) : null,
    "kcal",
    "active_energy",
  );
  const rhr = num(d.heartRate?.restingValue);
  push(
    "RESTING_HEART_RATE",
    rhr !== null && rhr > 0 ? Math.round(rhr) : null,
    "bpm",
    "rhr",
  );
  push("STRESS_LEVEL", scoreValue(num(d.stress?.avgLevel)), "score", "stress");
  push(
    "BODY_BATTERY",
    scoreValue(num(d.bodyBattery?.maxValue)),
    "score",
    "body_battery",
  );
  return out;
}

/**
 * One night of `dailySleepSummariesByDate`. Days without sleep come back as
 * an object whose `calendarDate` is null; those, and nights with no measured
 * sleep, map to nothing.
 *
 * Garmin gives stage totals, not a timeline, so the four stage rows are
 * stamped on the wake instant (the shape Oura's stage-total fallback writes),
 * and the per-night scalars sit there too.
 */
export function mapGarminSleep(
  s: GarminSleepSummary,
  tz?: string,
): GarminMappedMeasurement[] {
  if (!isDay(s.calendarDate)) return [];
  const sleepSeconds = num(s.sleepTimeSeconds);
  if (sleepSeconds === null || sleepSeconds <= 0) return [];
  const day = s.calendarDate;
  const measuredAt =
    parseGarminInstant(s.sleepEndTimestampGMT) ?? dayAnchor(day, tz);
  if (!measuredAt) return [];
  const out: GarminMappedMeasurement[] = [];

  const stages: Array<
    [number | null, NonNullable<GarminMappedMeasurement["sleepStage"]>, string]
  > = [
    [num(s.lightSleepSeconds), "CORE", "sleep_core"],
    [num(s.deepSleepSeconds), "DEEP", "sleep_deep"],
    [num(s.remSleepSeconds), "REM", "sleep_rem"],
    [num(s.awakeSleepSeconds), "AWAKE", "sleep_awake"],
  ];
  for (const [sec, stage, tag] of stages) {
    if (sec === null || sec < 0) continue;
    out.push({
      type: "SLEEP_DURATION",
      value: importValue(sec / 60),
      unit: "minutes",
      measuredAt,
      externalId: `sleep:${day}:${tag}`,
      sleepStage: stage,
      deviceType: "watch",
    });
  }

  const score = scoreValue(num(s.sleepScores?.overall?.value ?? null));
  if (score !== null) {
    out.push({
      type: "SLEEP_SCORE",
      value: score,
      unit: "score",
      measuredAt,
      externalId: `sleep:${day}:sleep_score`,
      deviceType: "watch",
    });
  }
  const spo2 = num(s.averageSpO2Value);
  if (spo2 !== null && spo2 > 0) {
    out.push({
      type: "OXYGEN_SATURATION",
      value: importValue(spo2),
      unit: "%",
      measuredAt,
      externalId: `sleep:${day}:spo2`,
      deviceType: "watch",
    });
  }
  const breath = num(s.averageRespirationValue);
  if (breath !== null && breath > 0) {
    out.push({
      type: "RESPIRATORY_RATE",
      value: importValue(breath),
      unit: "breaths/min",
      measuredAt,
      externalId: `sleep:${day}:resp_rate`,
      deviceType: "watch",
    });
  }
  return out;
}

/** The HRV daily envelope: each night's average (RMSSD) → `HRV_RMSSD`. */
export function mapGarminHrv(
  env: GarminHrvEnvelope | null,
  tz?: string,
): GarminMappedMeasurement[] {
  const out: GarminMappedMeasurement[] = [];
  for (const h of env?.hrvSummaries ?? []) {
    if (!isDay(h?.calendarDate)) continue;
    const v = num(h.lastNightAvg);
    if (v === null || v <= 0) continue;
    const measuredAt = dayAnchor(h.calendarDate, tz);
    if (!measuredAt) continue;
    out.push({
      type: "HRV_RMSSD",
      value: importValue(v),
      unit: "ms",
      measuredAt,
      externalId: `hrv:${h.calendarDate}:hrv_rmssd`,
      deviceType: "watch",
    });
  }
  return out;
}

/**
 * Above this a mass is grams, at or below it kilograms. Garmin's document
 * says kilograms; the live service has been seen sending grams. No human
 * weighs a tonne, and no muscle or bone mass reaches 1000 kg, so one bound
 * decides each field on its own.
 */
const GRAMS_ABOVE = 1000;

function kilograms(value: number | null): number | null {
  if (value === null || value <= 0) return null;
  return value > GRAMS_ABOVE ? value / 1000 : value;
}

/**
 * The weigh-in's stable id: Garmin's `samplePk` when it sends one (the live
 * service does, the document does not), else the reading's own GMT instant,
 * which a re-read reports unchanged.
 */
function weighInId(w: GarminWeighIn, measuredAt: Date): string {
  if (typeof w.samplePk === "number" || typeof w.samplePk === "string") {
    const id = String(w.samplePk).trim();
    if (id !== "") return id;
  }
  return `t${measuredAt.getTime()}`;
}

/** Why a weigh-in mapped to nothing. */
export type GarminWeighInDrop = "no_instant" | "no_weight" | "implausible";

export interface GarminWeighInMapping {
  rows: GarminMappedMeasurement[];
  dropped: GarminWeighInDrop | null;
}

/**
 * One weigh-in → its body-composition rows, all or nothing. A weigh-in whose
 * weight is missing, or any of whose values falls outside its type's band,
 * maps to no row at all: half a record (a BMI without the weight it was
 * computed from) reads as a complete one.
 */
export function mapGarminWeighIn(w: GarminWeighIn): GarminWeighInMapping {
  const measuredAt =
    parseGarminInstant(w.timestampGMT) ?? parseGarminInstant(w.date);
  if (!measuredAt) return { rows: [], dropped: "no_instant" };
  const kg = kilograms(num(w.weight));
  if (kg === null) return { rows: [], dropped: "no_weight" };
  const id = weighInId(w, measuredAt);
  // An Index scale reports through Garmin Connect; a typed entry is MANUAL.
  const deviceType =
    typeof w.sourceType === "string" &&
    w.sourceType.toUpperCase().includes("SCALE")
      ? ("scale" as const)
      : undefined;
  const rows: GarminMappedMeasurement[] = [];
  const push = (type: string, value: number | null, unit: string) => {
    if (value === null) return;
    rows.push({
      type,
      value,
      unit,
      measuredAt,
      externalId: `weight:${id}:${type.toLowerCase()}`,
      ...(deviceType ? { deviceType } : {}),
    });
  };
  push("WEIGHT", importValue(kg), "kg");
  const bmi = num(w.bmi);
  push(
    "BODY_MASS_INDEX",
    bmi !== null && bmi > 0 ? importValue(bmi) : null,
    "kg/m²",
  );
  const fat = num(w.bodyFat);
  push("BODY_FAT", fat !== null && fat > 0 ? importValue(fat) : null, "%");
  const water = num(w.bodyWater);
  push(
    "TOTAL_BODY_WATER",
    water !== null && water > 0 ? importValue((kg * water) / 100) : null,
    "kg",
  );
  const muscle = kilograms(num(w.muscleMass));
  push("MUSCLE_MASS", muscle === null ? null : importValue(muscle), "kg");
  const bone = kilograms(num(w.boneMass));
  push("BONE_MASS", bone === null ? null : importValue(bone), "kg");
  const visceral = num(w.visceralFat);
  push(
    "VISCERAL_FAT",
    visceral !== null && visceral >= 0 ? importValue(visceral) : null,
    "rating",
  );
  if (rows.some((r) => validateMeasurementRange(r.type, r.value) !== null)) {
    return { rows: [], dropped: "implausible" };
  }
  return { rows, dropped: null };
}

/**
 * Every weigh-in of a weight-range envelope, each once. A weigh-in that maps
 * to nothing is counted on the wide event by reason, never silently.
 */
export function mapGarminWeightRange(
  env: GarminWeightRangeEnvelope | null,
): GarminMappedMeasurement[] {
  const seen = new Set<string>();
  const out: GarminMappedMeasurement[] = [];
  const dropped: Partial<Record<GarminWeighInDrop, number>> = {};
  for (const day of env?.dailyWeightSummaries ?? []) {
    const entries = day?.allWeightMetrics?.length
      ? day.allWeightMetrics
      : day?.latestWeight
        ? [day.latestWeight]
        : [];
    for (const w of entries) {
      const mapped = mapGarminWeighIn(w);
      if (mapped.dropped) {
        dropped[mapped.dropped] = (dropped[mapped.dropped] ?? 0) + 1;
        continue;
      }
      for (const row of mapped.rows) {
        if (seen.has(row.externalId)) continue;
        seen.add(row.externalId);
        out.push(row);
      }
    }
  }
  if (Object.keys(dropped).length > 0) {
    annotate({ meta: { "garmin.weight.dropped": dropped } });
  }
  return out;
}
