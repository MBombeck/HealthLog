import { z } from "zod/v4";

export const measurementTypeEnum = z.enum([
  "WEIGHT",
  "BLOOD_PRESSURE_SYS",
  "BLOOD_PRESSURE_DIA",
  "PULSE",
  "BODY_FAT",
  "SLEEP_DURATION",
  "ACTIVITY_STEPS",
  "BLOOD_GLUCOSE",
  "TOTAL_BODY_WATER",
  "BONE_MASS",
  "OXYGEN_SATURATION",
  // ── v1.4.23 Apple Health additions ──
  "HEART_RATE_VARIABILITY",
  "RESTING_HEART_RATE",
  "ACTIVE_ENERGY_BURNED",
  "FLIGHTS_CLIMBED",
  "WALKING_RUNNING_DISTANCE",
  "VO2_MAX",
  "BODY_TEMPERATURE",
  // ── v1.4.25 W5d Withings full coverage ──
  "FAT_FREE_MASS",
  "FAT_MASS",
  "MUSCLE_MASS",
  "SKIN_TEMPERATURE",
  "PULSE_WAVE_VELOCITY",
  "VASCULAR_AGE",
  "VISCERAL_FAT",
  // ── v1.4.25 W8d Apple Health server-prep ──
  "AUDIO_EXPOSURE_ENV",
  "AUDIO_EXPOSURE_HEADPHONE",
  "TIME_IN_DAYLIGHT",
  // ── v1.4.30 R-F T1.4 + T1.5 ──
  "WALKING_STEADINESS",
  "AUDIO_EXPOSURE_EVENT",
]);

export const glucoseContextEnum = z.enum([
  "FASTING",
  "POSTPRANDIAL",
  "RANDOM",
  "BEDTIME",
]);

export const measurementSourceEnum = z.enum([
  "MANUAL",
  "WITHINGS",
  "IMPORT",
  "APPLE_HEALTH",
]);

const unitMap: Record<string, string> = {
  WEIGHT: "kg",
  BLOOD_PRESSURE_SYS: "mmHg",
  BLOOD_PRESSURE_DIA: "mmHg",
  PULSE: "bpm",
  BODY_FAT: "%",
  // v1.4.23 — sleep duration shifted from hours to minutes so HealthKit
  // category-sample stages can be stored without precision loss. Older
  // surfaces that need hours convert at read time (`minutes / 60`).
  SLEEP_DURATION: "minutes",
  ACTIVITY_STEPS: "steps",
  BLOOD_GLUCOSE: "mg/dL",
  TOTAL_BODY_WATER: "kg",
  BONE_MASS: "kg",
  OXYGEN_SATURATION: "%",
  // ── v1.4.23 Apple Health canonical units ──
  HEART_RATE_VARIABILITY: "ms",
  RESTING_HEART_RATE: "bpm",
  ACTIVE_ENERGY_BURNED: "kcal",
  FLIGHTS_CLIMBED: "flights",
  WALKING_RUNNING_DISTANCE: "m",
  VO2_MAX: "mL/(kg·min)",
  BODY_TEMPERATURE: "celsius",
  // ── v1.4.25 W5d Withings full coverage ──
  FAT_FREE_MASS: "kg",
  FAT_MASS: "kg",
  MUSCLE_MASS: "kg",
  // Distinct from BODY_TEMPERATURE — surface temps run ~32 °C; sharing
  // the bucket would corrupt analytics. Same canonical unit (°C).
  SKIN_TEMPERATURE: "celsius",
  PULSE_WAVE_VELOCITY: "m/s",
  VASCULAR_AGE: "years",
  // Withings reports visceral fat as a 1–12 rating, not a percent. The
  // string mirrors what Withings prints in Health Mate.
  VISCERAL_FAT: "rating",
  // ── v1.4.25 W8d Apple Health server-prep ──
  // Sound-pressure level — A-weighted decibels (dBA). HealthKit reports
  // both audio-exposure metrics in dBASPL; we store the unweighted "dBA"
  // label because the A-weighting is implicit (every HealthKit audio
  // sample carries it). 30 dBA = quiet bedroom; 140 dBA = pain threshold.
  AUDIO_EXPOSURE_ENV: "dBA",
  AUDIO_EXPOSURE_HEADPHONE: "dBA",
  // Daily-rollup pattern (one sample = one day's outdoor-light minutes).
  // 0–1440 covers the 24-hour day; in practice indoor users sit near 0
  // and outdoor athletes accumulate a few hours.
  TIME_IN_DAYLIGHT: "minutes",
};

export function getUnitForType(type: string): string {
  return unitMap[type] ?? "unknown";
}

// Plausible ranges per measurement type
const VALUE_RANGES: Record<string, { min: number; max: number }> = {
  WEIGHT: { min: 1, max: 500 },
  BLOOD_PRESSURE_SYS: { min: 40, max: 300 },
  BLOOD_PRESSURE_DIA: { min: 20, max: 200 },
  PULSE: { min: 20, max: 300 },
  BODY_FAT: { min: 1, max: 80 },
  // Minutes (v1.4.23 unit change). Per-stage rows can run from a few
  // seconds (a brief awakening) to 600+ minutes (a long IN_BED block),
  // so the upper bound covers a 24-hour day.
  SLEEP_DURATION: { min: 0, max: 1440 },
  ACTIVITY_STEPS: { min: 0, max: 200000 },
  BLOOD_GLUCOSE: { min: 20, max: 800 }, // mg/dL — covers severe hypo to severe hyperglycemia
  TOTAL_BODY_WATER: { min: 5, max: 100 }, // kg of water — adults typically 30–55 kg
  BONE_MASS: { min: 0.5, max: 8 }, // kg — adult plausibility (typical 2.5–4.5 kg)
  // Pulse oximetry (SpO2). BTS Guideline 2017 + ATS clinical practice put the
  // healthy resting range at 95–100%. We accept down to 50% so a faulty-sensor
  // critically-low reading still gets logged for the doctor to see; below 50%
  // is incompatible with sustained life and almost certainly a sensor glitch.
  OXYGEN_SATURATION: { min: 50, max: 100 },
  // ── v1.4.23 Apple Health ranges ──
  // HRV SDNN ms — Apple's own "high HRV" threshold sits ~80 ms; lows can
  // reach 5–10 ms in stressed/sick samples. 200 ms is a generous upper
  // bound for unusually relaxed athletic windows.
  HEART_RATE_VARIABILITY: { min: 1, max: 200 },
  // Resting HR bpm — endurance athletes can reach the high 30s; severe
  // tachycardia caps below 220.
  RESTING_HEART_RATE: { min: 25, max: 220 },
  // Active energy kcal/sample — a daily-rollup sample tops out around
  // 6–8000 kcal even for ultra-endurance days.
  ACTIVE_ENERGY_BURNED: { min: 0, max: 10000 },
  // Flights — vertical-feet/3 ≈ flights; cap generous.
  FLIGHTS_CLIMBED: { min: 0, max: 1000 },
  // Walking/running distance per sample (metres). 200 km covers an
  // ultra-marathon or a multi-stage day.
  WALKING_RUNNING_DISTANCE: { min: 0, max: 200000 },
  // VO2 max mL/(kg·min) — elite endurance hovers ~85; sedentary floor ~10.
  VO2_MAX: { min: 5, max: 100 },
  // Body temperature °C — survivable lows ~28; severe hyperthermia ~45.
  BODY_TEMPERATURE: { min: 28, max: 45 },
  // ── v1.4.25 W5d Withings full coverage ──
  // Fat-free mass kg — adult plausibility, ~30 kg (small adult) to 120 kg
  // (large lean athlete). Same bounds as weight minus a fat-mass floor.
  FAT_FREE_MASS: { min: 10, max: 250 },
  // Fat mass kg — pairs with FAT_FREE_MASS so totals reconcile to weight.
  FAT_MASS: { min: 0, max: 250 },
  // Muscle mass kg — sub-component of fat-free mass; widest sensible bound.
  MUSCLE_MASS: { min: 5, max: 200 },
  // Skin temperature °C — surface temps run cooler than core. ScanWatch's
  // dermal sensor reports a relative offset that lands in the 25–40 °C
  // band; treat anything outside as a sensor glitch.
  SKIN_TEMPERATURE: { min: 20, max: 45 },
  // Pulse-wave velocity m/s — clinical ranges sit ~4–15 m/s. Higher
  // numbers indicate stiffer arteries (cardiovascular risk).
  PULSE_WAVE_VELOCITY: { min: 1, max: 30 },
  // Vascular age in years — Withings derives this from PWV + chronological
  // age; the value is a "biological age" not a chronological one. Hard cap
  // at 130 because that's the human longevity record.
  VASCULAR_AGE: { min: 10, max: 130 },
  // Visceral fat rating 1–12 (Withings' own scale; not a percent).
  VISCERAL_FAT: { min: 0, max: 30 },
  // ── v1.4.25 W8d Apple Health server-prep ──
  // Audio exposure dBA — Apple's "loud audio" warning sits at 80 dBA;
  // concerts run 100–115 dBA; 140 dBA is the pain threshold. The floor
  // of 30 dBA covers a quiet bedroom; anything below is silence and
  // almost certainly a sensor artefact.
  AUDIO_EXPOSURE_ENV: { min: 30, max: 140 },
  // Headphone audio caps slightly below the open-air upper edge because
  // sealed-driver listening physically cannot reach a concert PA's SPL.
  AUDIO_EXPOSURE_HEADPHONE: { min: 30, max: 140 },
  // Time in daylight (minutes/day) — full 24-hour window. Outdoor work
  // tops the range; sedentary indoor days sit near 0.
  TIME_IN_DAYLIGHT: { min: 0, max: 1440 },
};

export function validateMeasurementRange(
  type: string,
  value: number,
): string | null {
  const range = VALUE_RANGES[type];
  if (range && (value < range.min || value > range.max)) {
    return `Value must be between ${range.min} and ${range.max}`;
  }
  return null;
}

export const createMeasurementSchema = z
  .object({
    type: measurementTypeEnum,
    value: z.number(),
    measuredAt: z.iso.datetime({ offset: true }).transform((s) => new Date(s)),
    notes: z.string().max(25).optional(),
    source: measurementSourceEnum.optional().default("MANUAL"),
    // Only applies when type === BLOOD_GLUCOSE. Mirrored by a CHECK
    // constraint in Postgres (see migration 0021).
    glucoseContext: glucoseContextEnum.optional(),
    // v1.4.25 W10 reconcile (code-review M4): the single-entry POST
    // dropped `deviceType` silently because the column existed on
    // `Measurement` and was accepted by the batch route, but never
    // declared in this schema. iOS clients that POST one row at a
    // time (and dashboards that backfill manual rows with device
    // metadata) now persist the tag instead of seeing it disappear.
    // Accepts `null` so a client can explicitly clear the column.
    deviceType: z.string().min(1).max(32).nullable().optional(),
  })
  .refine((data) => validateMeasurementRange(data.type, data.value) === null, {
    message: "Value out of plausible range",
  })
  .refine(
    (data) =>
      (data.type === "BLOOD_GLUCOSE" && data.glucoseContext !== undefined) ||
      (data.type !== "BLOOD_GLUCOSE" && data.glucoseContext === undefined),
    {
      message:
        "Blood glucose measurements require a context (fasting/postprandial/random/bedtime); other types must not set one.",
      path: ["glucoseContext"],
    },
  );

export const updateMeasurementSchema = z.object({
  value: z.number().min(0).max(500000).optional(),
  measuredAt: z.iso
    .datetime({ offset: true })
    .transform((s) => new Date(s))
    .optional(),
  notes: z
    .string()
    .max(25, "Note cannot exceed 25 characters")
    .nullable()
    .optional(),
});

export const listMeasurementsSchema = z.object({
  type: measurementTypeEnum.optional(),
  from: z.iso
    .datetime({ offset: true })
    .transform((s) => new Date(s))
    .optional(),
  to: z.iso
    .datetime({ offset: true })
    .transform((s) => new Date(s))
    .optional(),
  // v1.4.28 FB-D2 — when the chart sends an explicit from/to window the
  // payload is already bounded; lift the per-request ceiling to 5000
  // (still cheaper than the legacy unbounded `while (true)` walk).
  // Callers that omit from/to keep the historical 500-row cap.
  limit: z.coerce.number().int().min(1).max(5000).optional().default(100),
  offset: z.coerce.number().int().min(0).optional().default(0),
  sortBy: z
    .enum(["type", "value", "measuredAt", "source"])
    .optional()
    .default("measuredAt"),
  sortDir: z.enum(["asc", "desc"]).optional().default("desc"),
  // v1.4.28 FB-D2 — bucket hint for range-aware queries. When set the
  // GET handler runs a server-side `date_trunc` aggregation and returns
  // one row per bucket per type rather than the raw measurement rows.
  // Omitting `aggregate` keeps the raw wire shape (iOS contract); the
  // chart-data client must opt in explicitly.
  aggregate: z.enum(["raw", "daily", "weekly", "monthly"]).optional(),
});

export const createBatchMeasurementSchema = z.object({
  measurements: z.array(createMeasurementSchema).min(1).max(5),
});

export type CreateMeasurementInput = z.infer<typeof createMeasurementSchema>;
export type CreateBatchMeasurementInput = z.infer<
  typeof createBatchMeasurementSchema
>;
export type UpdateMeasurementInput = z.infer<typeof updateMeasurementSchema>;
export type ListMeasurementsInput = z.infer<typeof listMeasurementsSchema>;
