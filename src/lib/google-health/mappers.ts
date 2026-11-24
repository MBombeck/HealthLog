/**
 * Google Health pure mapping layer — payload → Measurement / Workout shapes.
 *
 * Split out of `client.ts` as pure code motion: the per-type `map*` functions,
 * the civil-date / local-instant parsing helpers, the sleep-stage + sport-type
 * resolvers, and the mapped-row types. `client.ts` re-exports this module, so
 * the sync layer and tests keep importing from `./client` unchanged.
 *
 * The shared wire-shape symbols (`GoogleHealthDataType`,
 * `GOOGLE_HEALTH_DATA_TYPES`, `GoogleHealthDataPoint`,
 * `GoogleHealthRollupPoint`) live HERE and `client.ts` imports them type-only:
 * that direction keeps the module graph acyclic (`client` → `mappers`, never
 * back), since `client.ts` also runtime-re-exports this module. No function in
 * this file performs I/O — everything is synchronous and deterministic given a
 * payload (+ optional user timezone).
 */
import { importValue } from "@/lib/integrations/import-value";
import { canonicalDailyTimestamp } from "@/lib/measurements/consolidation-tz";
import { zonedWallClockToUtc } from "@/lib/tz/wall-clock";
import { ownValue } from "@/lib/own-key";

/**
 * One data type's on-the-wire encodings. `path` is the kebab-case segment
 * spliced into the request URL; `filter` is the snake_case prefix used to build
 * the incremental `filter=` predicate; `key` is the camelCase union key the
 * response payload nests the value object under. `timeField` names the read
 * method + time anchor.
 */
export interface GoogleHealthDataType {
  /** kebab-case segment for the request path. */
  path: string;
  /** snake_case prefix for the `filter` predicate. */
  filter: string;
  /** camelCase union key in the response `DataPoint` payload. */
  key: string;
  /**
   * Which read method + time anchor the type uses:
   *   - `sample`     → spot reading via list; filter
   *     `{filter}.sample_time.physical_time`, read `{key}.sampleTime.physicalTime`.
   *   - `date`       → daily summary via list; filter `{filter}.date`
   *     (`YYYY-MM-DD`), read `{key}.date` (a `{year,month,day}` object).
   *   - `sessionEnd` → sleep sessions via list; sleep filters ONLY on
   *     `{filter}.interval.end_time` (any other field 400s); anchor
   *     `{key}.interval.endTime`.
   *   - `civilStart` → exercise sessions via list; session types filter ONLY on
   *     `{filter}.interval.civil_start_time` with an offset-less civil bound;
   *     times read from `{key}.interval.startTime/endTime` (RFC-3339).
   *   - `rollup`     → cumulative daily totals via `POST :dailyRollUp`
   *     (`windowSizeDays: 1`); never listed. Day key `civilStartTime.date`.
   */
  timeField: "sample" | "date" | "sessionEnd" | "civilStart" | "rollup";
}

/**
 * The launch data types. Each entry pins the kebab-path + snake-filter +
 * camelCase-payload triple so the three encodings can never drift. Identifiers
 * reconciled against the official v4 reference (data-types index + per-type
 * schema pages).
 */
export const GOOGLE_HEALTH_DATA_TYPES = {
  weight: {
    path: "weight",
    filter: "weight",
    key: "weight",
    timeField: "sample",
  },
  bodyFat: {
    path: "body-fat",
    filter: "body_fat",
    key: "bodyFat",
    timeField: "sample",
  },
  // Daily-grain SpO2 lives on `daily-oxygen-saturation` (`averagePercentage`);
  // the bare `oxygen-saturation` type is per-SAMPLE and does not accept a
  // `.date` filter (400).
  oxygenSaturation: {
    path: "daily-oxygen-saturation",
    filter: "daily_oxygen_saturation",
    key: "dailyOxygenSaturation",
    timeField: "date",
  },
  // Nightly HRV summary lives on `daily-heart-rate-variability`; the bare
  // `heart-rate-variability` type is per-sample (RMSSD + SDNN fields) and does
  // not accept a `.date` filter.
  heartRateVariability: {
    path: "daily-heart-rate-variability",
    filter: "daily_heart_rate_variability",
    key: "dailyHeartRateVariability",
    timeField: "date",
  },
  restingHeartRate: {
    path: "daily-resting-heart-rate",
    filter: "daily_resting_heart_rate",
    key: "dailyRestingHeartRate",
    timeField: "date",
  },
  // `respiratory-rate` does not exist in the catalogue; the daily summary is
  // `daily-respiratory-rate`, value leaf `dailyRespiratoryRate.breathsPerMinute`
  // (the once-assumed `dailyRespiratoryRateBpm` leaf never existed).
  respiratoryRate: {
    path: "daily-respiratory-rate",
    filter: "daily_respiratory_rate",
    key: "dailyRespiratoryRate",
    timeField: "date",
  },
  heartRate: {
    path: "heart-rate",
    filter: "heart_rate",
    key: "heartRate",
    timeField: "sample",
  },
  height: {
    path: "height",
    filter: "height",
    key: "height",
    timeField: "sample",
  },
  bloodGlucose: {
    path: "blood-glucose",
    filter: "blood_glucose",
    key: "bloodGlucose",
    timeField: "sample",
  },
  coreBodyTemperature: {
    path: "core-body-temperature",
    filter: "core_body_temperature",
    key: "coreBodyTemperature",
    timeField: "sample",
  },
  // Nightly sleep skin temperature. The documented `nightlyTemperatureCelsius`
  // is an ABSOLUTE reading ("the mean of skin temperature samples taken from
  // the user's sleep"), alongside a separate `baselineTemperatureCelsius` — so
  // it maps cleanly onto the absolute WRIST_TEMPERATURE slot. (An earlier note
  // claimed Google only ships a signed deviation; the schema refutes that.)
  sleepTemperature: {
    path: "daily-sleep-temperature-derivations",
    filter: "daily_sleep_temperature_derivations",
    key: "dailySleepTemperatureDerivations",
    timeField: "date",
  },
  // ── Activity bundle — daily cumulative totals ──────────────────
  // Scope: `googlehealth.activity_and_fitness.readonly`. Read through
  // `POST :dailyRollUp` with `windowSizeDays: 1`: the `list` surface returns
  // minute-grain observation buckets, NOT daily totals (and floors has no list
  // method at all). The externalId carries the `stats:` prefix so a re-fetched
  // day overwrites in place (mirrors the Apple-Health
  // `stats:<HK>:<YYYY-MM-DD>` daily-total overwrite contract).
  steps: { path: "steps", filter: "steps", key: "steps", timeField: "rollup" },
  distance: {
    path: "distance",
    filter: "distance",
    key: "distance",
    timeField: "rollup",
  },
  // Active energy — canonical id `active-energy-burned`; this is the ACTIVE
  // portion only, NOT `total-calories` (which folds in BMR).
  activeEnergy: {
    path: "active-energy-burned",
    filter: "active_energy_burned",
    key: "activeEnergyBurned",
    timeField: "rollup",
  },
  floors: {
    path: "floors",
    filter: "floors",
    key: "floors",
    timeField: "rollup",
  },
  // The daily VO2-max reading lives on `daily-vo2-max` (`vo2Max`); the bare
  // `vo2-max` type is per-sample and does not accept a `.date` filter.
  vo2Max: {
    path: "daily-vo2-max",
    filter: "daily_vo2_max",
    key: "dailyVo2Max",
    timeField: "date",
  },
  // ── Sleep bundle ───────────────────────────────────────────────
  // Scope: `googlehealth.sleep.readonly`. Sleep sessions filter ONLY on
  // `sleep.interval.end_time` / `.civil_end_time` — a start-time filter 400s.
  // Mapped to per-stage SLEEP_DURATION rows.
  sleep: {
    path: "sleep",
    filter: "sleep",
    key: "sleep",
    timeField: "sessionEnd",
  },
  // ── Exercise bundle ────────────────────────────────────────────
  // Scope: `googlehealth.activity_and_fitness.readonly`. Session types
  // (excluding sleep/ECG) filter ONLY on `interval.civil_start_time` with an
  // offset-less civil bound → a `Workout` row (NOT a Measurement).
  exercise: {
    path: "exercise",
    filter: "exercise",
    key: "exercise",
    timeField: "civilStart",
  },
} as const satisfies Record<string, GoogleHealthDataType>;

/** Google Health `DataPoint` — value object is type-keyed + carries a time anchor. */
export interface GoogleHealthDataPoint {
  [key: string]: unknown;
}

/**
 * One dailyRollUp aggregate window: `civilStartTime`/`civilEndTime` are
 * CivilDateTime objects (`{date:{year,month,day}, time:{…}}`), the value is a
 * union keyed by the camelCase type name carrying the `*Sum` rollup fields
 * (`steps.countSum`, `distance.millimetersSum`, `activeEnergyBurned.kcalSum`,
 * `floors.countSum` — int64 sums arrive as JSON strings).
 */
export interface GoogleHealthRollupPoint {
  [key: string]: unknown;
}

// ─── Field → Measurement mapping ───────────────────────────────
// The single source of truth is `mapping.md` — keep both in sync when adding
// entries.

/** Millimetres → centimetres (Google `height.heightMillimeters` → `User.heightCm`). */
const MM_TO_CM = 0.1;

/**
 * Coerce a raw payload value to a finite number, or null. proto3 int64 fields
 * arrive as JSON strings (`"12345"`); `Number()` handles both int and decimal
 * strings, guarded by a finite check (empty / whitespace strings coerce to 0
 * via `Number("")` — reject them explicitly).
 */
function coerceNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * A single mapped reading destined for one `Measurement` row. The `source`
 * (`GOOGLE_HEALTH`) and `externalId` (`<anchor>:<fieldTag>`) are stamped by the
 * sync layer; the mapper emits only type/value/unit/measuredAt + the field-tag
 * that disambiguates the externalId.
 */
export interface GoogleHealthMappedMeasurement {
  type: string;
  value: number;
  unit: string;
  measuredAt: Date;
  /** Disambiguator appended to the per-point anchor to form the externalId. */
  fieldTag: string;
  /** Per-stage sleep rows carry the SleepStage; everything else omits it. */
  sleepStage?: GoogleHealthSleepStage;
  /**
   * `true` when the externalId carries the `stats:` daily-total prefix (the
   * cumulative activity metrics). The sync layer stamps the externalId; this
   * flag lets it pick the right shape (`stats:<type-tag>:<YYYY-MM-DD>` vs the
   * `<anchor>:<fieldTag>` spot shape) without re-deriving the grain.
   */
  cumulativeDaily?: boolean;
}

/** HealthLog `SleepStage` values a Google sleep stage maps onto. */
export type GoogleHealthSleepStage =
  "IN_BED" | "AWAKE" | "ASLEEP" | "REM" | "CORE" | "DEEP";

/**
 * Pull the first finite STRICTLY-POSITIVE number out of a list of candidate
 * value paths on a `DataPoint`, coercing int64 JSON strings. The launch metrics
 * (weight, body-fat, SpO2, HRV, RHR, respiratory rate, HR, height, VO2 max) are
 * all strictly positive — a zero is a garbage/empty reading and is dropped.
 */
function firstNumber(
  point: GoogleHealthDataPoint,
  paths: string[],
): number | null {
  for (const path of paths) {
    const n = coerceNumber(readPath(point, path));
    if (n !== null && n > 0) return n;
  }
  return null;
}

/** Resolve a dotted path against a nested object; undefined on any miss. */
function readPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = ownValue(cur as Record<string, unknown>, seg);
  }
  return cur;
}

/**
 * Read a Google civil date — a `{year,month,day}` object, or a civil string
 * (`YYYY-MM-DD`, optionally with a time suffix like `2026-06-02T00:00:00`) —
 * as a `YYYY-MM-DD` day key, or null. The key names the row's externalId; the
 * row's instant is the key's local noon in the user's zone
 * (`canonicalDailyTimestamp`), which reads the same calendar day there. Noon
 * UTC, the previous anchor, is already the next day from UTC+13 on.
 */
function parseCivilKey(val: unknown): string | null {
  if (typeof val === "string") {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(val.trim());
    return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
  }
  if (!val || typeof val !== "object") return null;
  const o = val as Record<string, unknown>;
  if (
    typeof o.year === "number" &&
    typeof o.month === "number" &&
    typeof o.day === "number"
  ) {
    const pad = (n: number, w: number) => String(n).padStart(w, "0");
    return `${pad(o.year, 4)}-${pad(o.month, 2)}-${pad(o.day, 2)}`;
  }
  return null;
}

/**
 * Matches an offset-less local ISO wall-clock string (`2026-06-02T03:02:30` /
 * `...T03:02:30.000`). No trailing `Z`, no `±hh:mm` — those denote an absolute
 * instant and are honoured verbatim.
 */
const OFFSET_LESS_LOCAL_ISO =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/;

/**
 * Parse a Google timestamp into a UTC instant. Sleep segments + exercise
 * sessions can emit LOCAL wall-clock strings WITHOUT an offset — the night /
 * session belongs to the user's local clock, so an offset-less string is
 * resolved against the USER'S timezone, not the process zone (a bare
 * `new Date(iso)` parses an offset-less string in the host zone, which shifts a
 * non-UTC user by their offset and can flip a near-midnight wake-day). When `tz`
 * is omitted the host-local fallback preserves the prior behaviour. Strings that
 * DO carry an offset/`Z` are absolute and parsed as-is. Mirrors the Fitbit
 * `parseLocalInstant`. Returns null on a miss.
 */
function parseLocalInstant(iso: string, tz?: string): Date | null {
  const m = OFFSET_LESS_LOCAL_ISO.exec(iso.trim());
  if (m) {
    return zonedWallClockToUtc(
      {
        year: Number(m[1]),
        month: Number(m[2]),
        day: Number(m[3]),
        hour: Number(m[4]),
        minute: Number(m[5]),
        second: m[6] ? Number(m[6]) : 0,
      },
      tz,
    );
  }
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Resolve a `DataPoint`'s measurement timestamp. The read paths are camelCase —
 * the response payload nests the value union under the camelCase type name with
 * camelCase time objects (the snake_case forms exist only inside the request
 * `filter` parameter).
 *   - `sample` → `{key}.sampleTime.physicalTime` (a spot instant; offset-less
 *     strings resolve against `tz`).
 *   - `date`   → `{key}.date` (a `{year,month,day}` object, or a civil string) —
 *     anchored at local noon of that day in the user's zone.
 * Falls back to `fallback` only when nothing parses, so a row is never dropped
 * for a missing anchor. (Sleep / exercise sessions and the rollup types anchor
 * through their own helpers, never here.)
 */
function resolveMeasuredAt(
  point: GoogleHealthDataPoint,
  dataType: GoogleHealthDataType,
  fallback: Date,
  tz?: string,
): Date {
  if (dataType.timeField === "sample") {
    const t = readPath(point, `${dataType.key}.sampleTime.physicalTime`);
    if (typeof t === "string") {
      const d = parseLocalInstant(t, tz);
      if (d) return d;
    }
  } else if (dataType.timeField === "date") {
    const day = parseCivilKey(readPath(point, `${dataType.key}.date`));
    if (day) return canonicalDailyTimestamp(day, tz);
  }
  return fallback;
}

/**
 * The sample instant of a spot-reading `DataPoint` (`sample` data types), or
 * null for any other shape or a point without a parseable time. A backfill
 * reads it to record how far a walk has got.
 */
export function googleHealthSampleInstant(
  point: GoogleHealthDataPoint,
  dataType: GoogleHealthDataType,
  tz?: string,
): Date | null {
  if (dataType.timeField !== "sample") return null;
  const t = readPath(point, `${dataType.key}.sampleTime.physicalTime`);
  return typeof t === "string" ? parseLocalInstant(t, tz) : null;
}

/**
 * Stable anchor for a `DataPoint`'s externalId. A spot reading anchors on its
 * sample time; a daily summary on its civil date. Combined with a type-specific
 * field-tag this makes the upsert key idempotent across re-fetches.
 */
function externalAnchor(
  point: GoogleHealthDataPoint,
  dataType: GoogleHealthDataType,
  tz?: string,
): string {
  // Daily summaries share the civil-day externalId grain so a re-fetched day
  // overwrites in place. (Sleep/exercise sessions and the rollup daily totals
  // mint their own anchors and never reach this helper.)
  if (dataType.timeField === "date") {
    const day = parseCivilKey(readPath(point, `${dataType.key}.date`));
    if (day) return day;
  }
  return resolveMeasuredAt(point, dataType, new Date(0), tz).toISOString();
}

/**
 * Map one data point of a simple single-value metric into a Measurement
 * reading. `valuePaths` lists the candidate value shapes; the first
 * finite-positive hit wins. Returns an empty array when no value parses.
 */
function mapSimple(
  point: GoogleHealthDataPoint,
  dataType: GoogleHealthDataType,
  spec: {
    type: string;
    unit: string;
    fieldTag: string;
    valuePaths: string[];
    factor?: number;
  },
  tz: string | undefined,
): GoogleHealthMappedMeasurement[] {
  let value = firstNumber(point, spec.valuePaths);
  if (value === null) return [];
  if (spec.factor) value = value * spec.factor;
  return [
    {
      type: spec.type,
      value: importValue(value),
      unit: spec.unit,
      measuredAt: resolveMeasuredAt(point, dataType, new Date(), tz),
      fieldTag: `${externalAnchor(point, dataType)}:${spec.fieldTag}`,
    },
  ];
}

export function mapWeight(
  point: GoogleHealthDataPoint,
  tz?: string,
): GoogleHealthMappedMeasurement[] {
  const dt = GOOGLE_HEALTH_DATA_TYPES.weight;
  // Documented field is `weightGrams` (grams) → kg.
  return mapSimple(
    point,
    dt,
    {
      type: "WEIGHT",
      unit: "kg",
      fieldTag: "weight",
      valuePaths: [`${dt.key}.weightGrams`],
      factor: 0.001,
    },
    tz,
  );
}

export function mapBodyFat(
  point: GoogleHealthDataPoint,
  tz?: string,
): GoogleHealthMappedMeasurement[] {
  const dt = GOOGLE_HEALTH_DATA_TYPES.bodyFat;
  return mapSimple(
    point,
    dt,
    {
      type: "BODY_FAT",
      unit: "%",
      fieldTag: "body_fat",
      valuePaths: [`${dt.key}.percentage`],
    },
    tz,
  );
}

export function mapOxygenSaturation(
  point: GoogleHealthDataPoint,
  tz?: string,
): GoogleHealthMappedMeasurement[] {
  const dt = GOOGLE_HEALTH_DATA_TYPES.oxygenSaturation;
  return mapSimple(
    point,
    dt,
    {
      type: "OXYGEN_SATURATION",
      unit: "%",
      fieldTag: "spo2",
      valuePaths: [`${dt.key}.averagePercentage`],
    },
    tz,
  );
}

export function mapHeartRateVariability(
  point: GoogleHealthDataPoint,
  tz?: string,
): GoogleHealthMappedMeasurement[] {
  const dt = GOOGLE_HEALTH_DATA_TYPES.heartRateVariability;
  // Google documents the daily average as RMSSD ("average heart rate
  // variability calculated using the root mean square of successive
  // differences"), the same estimator the classic Fitbit API reports as
  // `dailyRmssd`. It lands in `HRV_RMSSD`, apart from the SDNN
  // `HEART_RATE_VARIABILITY` series.
  return mapSimple(
    point,
    dt,
    {
      type: "HRV_RMSSD",
      unit: "ms",
      fieldTag: "hrv",
      valuePaths: [`${dt.key}.averageHeartRateVariabilityMilliseconds`],
    },
    tz,
  );
}

export function mapRestingHeartRate(
  point: GoogleHealthDataPoint,
  tz?: string,
): GoogleHealthMappedMeasurement[] {
  const dt = GOOGLE_HEALTH_DATA_TYPES.restingHeartRate;
  // `beatsPerMinute` is an int64 JSON string — coerced by the extractor.
  return mapSimple(
    point,
    dt,
    {
      type: "RESTING_HEART_RATE",
      unit: "bpm",
      fieldTag: "rhr",
      valuePaths: [`${dt.key}.beatsPerMinute`],
    },
    tz,
  );
}

export function mapRespiratoryRate(
  point: GoogleHealthDataPoint,
  tz?: string,
): GoogleHealthMappedMeasurement[] {
  const dt = GOOGLE_HEALTH_DATA_TYPES.respiratoryRate;
  // Documented schema: `{ date, breathsPerMinute }` — `breathsPerMinute` is a
  // plain number ("The average number of breaths taken per minute"). The
  // earlier `dailyRespiratoryRateBpm` leaf does not exist and never parsed.
  return mapSimple(
    point,
    dt,
    {
      type: "RESPIRATORY_RATE",
      unit: "breaths/min",
      fieldTag: "resp_rate",
      valuePaths: [`${dt.key}.breathsPerMinute`],
    },
    tz,
  );
}

export function mapBloodGlucose(
  point: GoogleHealthDataPoint,
  tz?: string,
): GoogleHealthMappedMeasurement[] {
  const dt = GOOGLE_HEALTH_DATA_TYPES.bloodGlucose;
  // Documented field `bloodGlucoseMilligramsPerDeciliter` (number) — already in
  // HealthLog's canonical mg/dL storage unit, no conversion.
  return mapSimple(
    point,
    dt,
    {
      type: "BLOOD_GLUCOSE",
      unit: "mg/dL",
      fieldTag: "glucose",
      valuePaths: [`${dt.key}.bloodGlucoseMilligramsPerDeciliter`],
    },
    tz,
  );
}

export function mapCoreBodyTemperature(
  point: GoogleHealthDataPoint,
  tz?: string,
): GoogleHealthMappedMeasurement[] {
  const dt = GOOGLE_HEALTH_DATA_TYPES.coreBodyTemperature;
  // Documented field `temperatureCelsius` (number) → the core BODY_TEMPERATURE
  // slot (distinct from SKIN_TEMPERATURE / WRIST_TEMPERATURE surface readings).
  return mapSimple(
    point,
    dt,
    {
      type: "BODY_TEMPERATURE",
      unit: "celsius",
      fieldTag: "core_temp",
      valuePaths: [`${dt.key}.temperatureCelsius`],
    },
    tz,
  );
}

export function mapWristTemperature(
  point: GoogleHealthDataPoint,
  tz?: string,
): GoogleHealthMappedMeasurement[] {
  const dt = GOOGLE_HEALTH_DATA_TYPES.sleepTemperature;
  // `nightlyTemperatureCelsius` is the ABSOLUTE nightly skin temperature ("the
  // mean of skin temperature samples taken from the user's sleep") → the
  // WRIST_TEMPERATURE slot, mirroring the Apple sleeping-wrist-temperature
  // absolute-reading convention. The sibling `baselineTemperatureCelsius` /
  // `relativeNightlyStddev30dCelsius` derivations are not stored — the user's
  // own series carries the baseline.
  return mapSimple(
    point,
    dt,
    {
      type: "WRIST_TEMPERATURE",
      unit: "celsius",
      fieldTag: "wrist_temp",
      valuePaths: [`${dt.key}.nightlyTemperatureCelsius`],
    },
    tz,
  );
}

export function mapHeartRate(
  point: GoogleHealthDataPoint,
  tz?: string,
): GoogleHealthMappedMeasurement[] {
  const dt = GOOGLE_HEALTH_DATA_TYPES.heartRate;
  // `beatsPerMinute` is an int64 JSON string.
  return mapSimple(
    point,
    dt,
    {
      type: "PULSE",
      unit: "bpm",
      fieldTag: "hr",
      valuePaths: [`${dt.key}.beatsPerMinute`],
    },
    tz,
  );
}

/** One extracted `height` sample: centimetres + the sample instant (if any). */
export interface GoogleHealthHeightSample {
  cm: number;
  sampledAt: Date | null;
}

/**
 * Extract the profile height from a Google `height` data point, or null when
 * nothing parses. Height is a one-time `User.heightCm` profile seed (written
 * only when the user has no height yet) — NOT a Measurement. The documented
 * field is `heightMillimeters` (int64 JSON string, millimetres) → cm ÷ 10.
 * (The earlier `heightMeters` leaf does not exist and never parsed.)
 * `sampledAt` lets the caller pick the LATEST sample explicitly — list
 * responses are ordered DESCENDING, so "last row wins" would pick the OLDEST.
 */
export function mapHeight(
  point: GoogleHealthDataPoint,
): GoogleHealthHeightSample | null {
  const dt = GOOGLE_HEALTH_DATA_TYPES.height;
  const mm = firstNumber(point, [`${dt.key}.heightMillimeters`]);
  if (mm === null) return null;
  const t = readPath(point, `${dt.key}.sampleTime.physicalTime`);
  const sampledAt = typeof t === "string" ? parseLocalInstant(t) : null;
  return { cm: importValue(mm * MM_TO_CM), sampledAt };
}

// ─── Activity mappers: daily roll-up totals ────────────────────

/**
 * Pull the first finite NON-negative number out of a list of candidate value
 * paths, coercing int64 JSON strings. Unlike `firstNumber` (strictly positive),
 * this admits a legitimate zero — a day of rest still records 0 steps /
 * 0 floors / 0 active kcal, and dropping the zero would leave a hole the chart
 * misreads as missing data.
 */
function firstNonNegativeNumber(
  point: GoogleHealthDataPoint,
  paths: string[],
): number | null {
  for (const path of paths) {
    const n = coerceNumber(readPath(point, path));
    if (n !== null && n >= 0) return n;
  }
  return null;
}

/**
 * Map one `dailyRollUp` aggregate window (`windowSizeDays: 1`) into a single
 * daily-total Measurement reading. The day key comes from the window's
 * `civilStartTime.date` (a `{year,month,day}` object), anchored at local noon
 * of that day in the user's zone; a window with no parseable civil day is
 * dropped (it cannot be keyed). The externalId is the `stats:`-prefixed
 * daily-total shape so a re-fetched day overwrites in place — the same
 * overwrite contract the Apple-Health `stats:<HK>:<YYYY-MM-DD>` daily totals
 * use. A zero is preserved (a rest day is real data, not a gap).
 */
function mapDailyRollup(
  point: GoogleHealthRollupPoint,
  spec: {
    type: string;
    unit: string;
    fieldTag: string;
    valuePaths: string[];
    factor?: number;
  },
  tz: string | undefined,
): GoogleHealthMappedMeasurement[] {
  const dayKey =
    parseCivilKey(readPath(point, "civilStartTime.date")) ??
    parseCivilKey(readPath(point, "civilStartTime"));
  if (!dayKey) return [];
  let value = firstNonNegativeNumber(point, spec.valuePaths);
  if (value === null) return [];
  if (spec.factor) value = value * spec.factor;
  return [
    {
      type: spec.type,
      value: importValue(value),
      unit: spec.unit,
      measuredAt: canonicalDailyTimestamp(dayKey, tz),
      // `stats:<type-tag>:<YYYY-MM-DD>` — the sync layer reads `cumulativeDaily`
      // to assemble the externalId, matching the Apple-Health daily-total shape.
      fieldTag: `${spec.fieldTag}:${dayKey}`,
      cumulativeDaily: true,
    },
  ];
}

export function mapSteps(
  point: GoogleHealthRollupPoint,
  tz?: string,
): GoogleHealthMappedMeasurement[] {
  const dt = GOOGLE_HEALTH_DATA_TYPES.steps;
  // `countSum` is an int64 JSON string.
  return mapDailyRollup(
    point,
    {
      type: "ACTIVITY_STEPS",
      unit: "steps",
      fieldTag: "steps",
      valuePaths: [`${dt.key}.countSum`],
    },
    tz,
  );
}

export function mapDistance(
  point: GoogleHealthRollupPoint,
  tz?: string,
): GoogleHealthMappedMeasurement[] {
  const dt = GOOGLE_HEALTH_DATA_TYPES.distance;
  // `millimetersSum` is an int64 JSON string → metres.
  return mapDailyRollup(
    point,
    {
      type: "WALKING_RUNNING_DISTANCE",
      unit: "m",
      fieldTag: "distance",
      valuePaths: [`${dt.key}.millimetersSum`],
      factor: 0.001,
    },
    tz,
  );
}

export function mapActiveEnergy(
  point: GoogleHealthRollupPoint,
  tz?: string,
): GoogleHealthMappedMeasurement[] {
  const dt = GOOGLE_HEALTH_DATA_TYPES.activeEnergy;
  // ACTIVE energy only — NOT total-calories (which folds in BMR).
  return mapDailyRollup(
    point,
    {
      type: "ACTIVE_ENERGY_BURNED",
      unit: "kcal",
      fieldTag: "active_energy",
      valuePaths: [`${dt.key}.kcalSum`],
    },
    tz,
  );
}

export function mapFloors(
  point: GoogleHealthRollupPoint,
  tz?: string,
): GoogleHealthMappedMeasurement[] {
  const dt = GOOGLE_HEALTH_DATA_TYPES.floors;
  // `countSum` is an int64 JSON string.
  return mapDailyRollup(
    point,
    {
      type: "FLIGHTS_CLIMBED",
      unit: "flights",
      fieldTag: "floors",
      valuePaths: [`${dt.key}.countSum`],
    },
    tz,
  );
}

/**
 * Map one `daily-vo2-max` summary into a VO2_MAX reading. A daily latest-wins
 * metric (one civil-date reading, strictly positive — not a running sum), read
 * via list with a `.date` filter; it keeps the `stats:`-style per-day overwrite
 * key so a re-rolled day replaces in place.
 */
export function mapVo2Max(
  point: GoogleHealthDataPoint,
  tz?: string,
): GoogleHealthMappedMeasurement[] {
  const dt = GOOGLE_HEALTH_DATA_TYPES.vo2Max;
  const value = firstNumber(point, [`${dt.key}.vo2Max`]);
  if (value === null) return [];
  const measuredAt = resolveMeasuredAt(point, dt, new Date(), tz);
  return [
    {
      type: "VO2_MAX",
      value: importValue(value),
      unit: "mL/(kg·min)",
      measuredAt,
      fieldTag: `vo2_max:${externalAnchor(point, dt)}`,
      cumulativeDaily: true,
    },
  ];
}

// ── Sleep ──────────────────────────────────────────────────────
//
// A Google Health sleep session carries a list of per-stage segments, each with
// a stage label + a start + end. HealthLog stores one SLEEP_DURATION row per
// stage segment with `measuredAt = stage END` (so the night-total + hypnogram
// readers consume the same enum WHOOP / Apple write). The stage labels are
// harmonised onto the shared `SleepStage` enum.

/** Google Health sleep stage label → HealthLog `SleepStage`. */
const GOOGLE_HEALTH_SLEEP_STAGE_MAP: Record<string, GoogleHealthSleepStage> = {
  // Canonical Google Health stage names (snake / lower variants accepted).
  in_bed: "IN_BED",
  inbed: "IN_BED",
  awake: "AWAKE",
  wake: "AWAKE",
  light: "CORE", // "light" ↔ Apple "core" (same shallow-NREM band)
  core: "CORE",
  rem: "REM",
  deep: "DEEP",
  // The classic (non-stages) sleep log uses asleep/restless/wake.
  asleep: "ASLEEP",
  restless: "AWAKE",
} as const;

/**
 * Normalise a raw Google sleep-stage label to a `SleepStage`, or null for an
 * unknown label (skipped rather than mis-bucketed).
 */
export function mapGoogleHealthSleepStage(
  raw: unknown,
): GoogleHealthSleepStage | null {
  if (typeof raw !== "string") return null;
  const key = raw
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return (
    ownValue(GOOGLE_HEALTH_SLEEP_STAGE_MAP, key) ??
    ownValue(GOOGLE_HEALTH_SLEEP_STAGE_MAP, key.replace(/_/g, "")) ??
    null
  );
}

/** One sleep-stage segment pulled defensively off a Google sleep session. */
interface GoogleHealthSleepSegment {
  stage: string;
  startTime?: string;
  endTime?: string;
}

/** Minutes between two ISO instants, or null if either is unparseable. */
function minutesBetween(startIso?: string, endIso?: string): number | null {
  if (!startIso || !endIso) return null;
  const s = new Date(startIso).getTime();
  const e = new Date(endIso).getTime();
  if (Number.isNaN(s) || Number.isNaN(e) || e <= s) return null;
  return (e - s) / 60_000;
}

/**
 * Read the per-stage segments off a Google sleep `DataPoint`. Documented shape:
 * `sleep.stages` is an array of
 * `{ startTime, startUtcOffset, endTime, endUtcOffset, type }` where `type` is
 * the `SLEEP_STAGE_TYPE` enum (`AWAKE | LIGHT | DEEP | REM | ASLEEP | RESTLESS
 * | SLEEP_STAGE_TYPE_UNSPECIFIED`) and the times are RFC-3339 Timestamps.
 */
function readSleepSegments(
  point: GoogleHealthDataPoint,
): GoogleHealthSleepSegment[] {
  const stages = readPath(point, "sleep.stages");
  if (!Array.isArray(stages)) return [];
  const out: GoogleHealthSleepSegment[] = [];
  for (const raw of stages) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const stage = typeof o.type === "string" ? o.type : "";
    const startTime = typeof o.startTime === "string" ? o.startTime : undefined;
    const endTime = typeof o.endTime === "string" ? o.endTime : undefined;
    if (stage) out.push({ stage, startTime, endTime });
  }
  return out;
}

/**
 * The stable session anchor for a sleep `DataPoint`'s externalId.
 *
 * Prefers the Google resource id (`name`) — it is INVARIANT across Google's
 * after-the-fact re-scoring of a night, so the per-segment rows keep the SAME
 * externalId on a re-fetch and overwrite in place instead of minting parallel
 * duplicates. This mirrors `mapWorkout`, which anchors on `name` for exactly
 * this reason.
 *
 * The session interval end/start is only a FALLBACK (for a payload without a
 * resource name): it SHIFTS whenever Google refines the wake/onset instant on a
 * re-score, which is precisely what used to duplicate a night's rows. Paths are
 * camelCase (`sleep.interval.endTime`) — the response payload never uses
 * snake_case.
 */
function sleepSessionAnchor(point: GoogleHealthDataPoint, tz?: string): string {
  const name = readPath(point, "name");
  if (typeof name === "string" && name !== "") return name;
  const end = readPath(point, "sleep.interval.endTime");
  if (typeof end === "string") {
    const d = parseLocalInstant(end, tz);
    if (d) return d.toISOString();
  }
  const start = readPath(point, "sleep.interval.startTime");
  if (typeof start === "string") {
    const d = parseLocalInstant(start, tz);
    if (d) return d.toISOString();
  }
  return new Date(0).toISOString();
}

/**
 * One mapped Google sleep session: the stable anchor, the session's covered
 * time window (earliest segment start → latest segment end, both UTC), and the
 * per-segment rows. The window drives the sync's replace-by-window cleanup of
 * stale rows a re-score orphaned; `rows` is what gets upserted.
 */
export interface GoogleHealthSleepSession {
  /** Stable session anchor — also the `<anchor>:sleep:` externalId prefix. */
  anchor: string;
  /** Earliest segment start across the session (UTC), or null if none map. */
  windowStart: Date | null;
  /** Latest segment end across the session (UTC), or null if none map. */
  windowEnd: Date | null;
  rows: GoogleHealthMappedMeasurement[];
  /**
   * Segments skipped because their stage label is not one this mapper knows
   * (`SLEEP_STAGE_TYPE_UNSPECIFIED`, or a label Google adds later). Counted
   * rather than dropped in silence: the night total reads short by exactly
   * these segments, and the sync's wide event is where that shows.
   */
  unknownStageSegments: number;
  /** The distinct unknown labels, for the wide event (at most five). */
  unknownStageLabels: string[];
}

/**
 * Map one Google sleep session into per-SEGMENT `SLEEP_DURATION` rows plus its
 * covered window. The Google sleep payload carries a real per-stage segment
 * series (each with its own start/end), so one row is emitted PER SEGMENT —
 * `measuredAt = that segment's END`. The timeline is MEASURED (real onsets), so
 * these rows are NOT flagged reconstructed — unlike WHOOP, which has no onsets.
 *
 * Each segment's fieldTag keys off the STABLE session anchor plus the segment's
 * own START instant — `<anchor>:sleep:<segment-start>` — NOT a positional index
 * and NOT the stage label. This is the fix for the re-score duplication: a
 * positional index renumbered (and a stage-scoped tag changed) whenever Google
 * re-scored a night, minting fresh externalIds so the upsert created parallel
 * duplicate rows the night-total then double-counted. A segment's start instant
 * is stable per block, and dropping the stage from the key means a mere
 * re-classification (LIGHT→DEEP on the same block) UPDATES the row in place
 * rather than orphaning it. Unknown stage labels are skipped and counted
 * (`unknownStageSegments`); a session with no
 * parseable segment yields an empty `rows` (and a null window).
 *
 * Segment timestamps can arrive OFFSET-LESS (local wall clock); `tz` (the user's
 * stored zone) anchors them to the correct UTC instant rather than the process
 * zone — without it a non-UTC user's near-midnight segment END would shift by
 * their offset. Timestamps carrying an explicit offset/`Z` are honoured as-is.
 */
export function mapSleepSessionDetailed(
  point: GoogleHealthDataPoint,
  tz?: string,
): GoogleHealthSleepSession {
  const anchor = sleepSessionAnchor(point, tz);
  const segments = readSleepSegments(point);
  const rows: GoogleHealthMappedMeasurement[] = [];
  let windowStart: Date | null = null;
  let windowEnd: Date | null = null;
  let unknownStageSegments = 0;
  const unknownStageLabels = new Set<string>();

  for (const seg of segments) {
    const stage = mapGoogleHealthSleepStage(seg.stage);
    if (!stage) {
      unknownStageSegments += 1;
      if (unknownStageLabels.size < 5) {
        unknownStageLabels.add(seg.stage.slice(0, 40));
      }
      continue;
    }
    const mins = minutesBetween(seg.startTime, seg.endTime);
    if (mins === null || !(mins > 0)) continue;
    const start = parseLocalInstant(seg.startTime as string, tz);
    const end = parseLocalInstant(seg.endTime as string, tz);
    if (!start || !end) continue;
    if (!windowStart || start < windowStart) windowStart = start;
    if (!windowEnd || end > windowEnd) windowEnd = end;
    rows.push({
      type: "SLEEP_DURATION",
      value: importValue(mins),
      unit: "minutes",
      measuredAt: end,
      fieldTag: `${anchor}:sleep:${start.toISOString()}`,
      sleepStage: stage,
    });
  }

  return {
    anchor,
    windowStart,
    windowEnd,
    rows,
    unknownStageSegments,
    unknownStageLabels: [...unknownStageLabels],
  };
}

// ── Workouts (exercise sessions) ───────────────────────────────

/**
 * Google Health `Exercise.exerciseType` → HealthLog `WorkoutSportType`. The
 * enum arrives UPPERCASE (`RUNNING`, `STRENGTH_TRAINING`, …); the resolver
 * lowercases + underscores before the lookup, so the keys here are the
 * normalised forms. An unmapped type resolves to the literal `"other"`: the
 * upstream label does NOT survive in `sportType`, and the column read back
 * cannot tell a genuine `OTHER_WORKOUT` from a sport this map has never heard
 * of. What preserves it is `GoogleHealthMappedWorkout.sportTypeRaw`, which the
 * ingest writes verbatim to `Workout.metadata.googleExerciseType`
 * (`sync-workout.ts`) — so a session that shows as "other" can still be traced
 * back to what Google sent, without re-fetching it.
 */
const GOOGLE_HEALTH_EXERCISE_TYPE_MAP: Record<string, string> = {
  walk: "walking",
  walking: "walking",
  treadmill_walk: "walking",
  incline_walk: "walking",
  power_walking: "walking",
  nordic_walking: "walking",
  stroller_walk: "walking",
  walk_with_weights: "walking",
  run: "running",
  running: "running",
  treadmill: "running",
  treadmill_running: "running",
  trail_run: "running",
  incline_run: "running",
  bike: "cycling",
  biking: "cycling",
  cycling: "cycling",
  spinning: "cycling",
  mountain_biking: "cycling",
  mountain_bike: "cycling",
  outdoor_bike: "cycling",
  stationary_bike: "cycling",
  electric_bike: "cycling",
  assault_bike: "cycling",
  hike: "hiking",
  hiking: "hiking",
  backpacking: "hiking",
  rucking: "hiking",
  swim: "swimming",
  swimming: "swimming",
  swimming_pool: "swimming",
  swimming_open_water: "swimming",
  rowing: "rowing",
  rowing_machine: "rowing",
  elliptical: "elliptical",
  stairclimber: "stairClimber",
  stair_climbing: "stairClimber",
  step_training: "stairClimber",
  yoga: "yoga",
  pilates: "mindAndBody",
  meditate: "mindAndBody",
  tai_chi: "mindAndBody",
  stretching: "mindAndBody",
  weights: "strength",
  strength: "strength",
  strength_training: "strength",
  functional_strength_training: "strength",
  weightlifting: "strength",
  powerlifting: "strength",
  free_weights: "strength",
  body_weight: "strength",
  resistance_bands: "strength",
  calisthenics: "strength",
  core_training: "strength",
  workout: "strength",
  hiit: "hiit",
  high_intensity_interval_training: "hiit",
  interval_workout: "hiit",
  interval_training: "hiit",
  tabata_workout: "hiit",
  dance: "dance",
  dancing: "dance",
  golf: "golf",
  badminton: "badminton",
  tennis: "tennis",
  basketball: "basketball",
  soccer: "soccer",
  football: "soccer",
  bootcamp: "crossTraining",
  circuit_training: "crossTraining",
  crossfit: "crossTraining",
  cross_training: "crossTraining",
  aerobic_workout: "mixedCardio",
  cardio_workout: "mixedCardio",
  cardio_sculpt: "mixedCardio",
  sport: "mixedCardio",
} as const;

/** Resolve a Google exercise activity type to a canonical sport label. */
export function mapGoogleHealthSportType(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "") return "other";
  const key = raw
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return (
    ownValue(GOOGLE_HEALTH_EXERCISE_TYPE_MAP, key) ??
    ownValue(GOOGLE_HEALTH_EXERCISE_TYPE_MAP, key.replace(/_/g, "")) ??
    "other"
  );
}

/** One mapped Google exercise session destined for a `Workout` row. */
export interface GoogleHealthMappedWorkout {
  externalId: string;
  sportType: string;
  /**
   * The upstream `exercise.exerciseType` verbatim (trimmed), or null when the
   * session carried none. Provenance only — never the canonical `sportType`,
   * which `mapGoogleHealthSportType()` owns.
   */
  sportTypeRaw: string | null;
  startedAt: Date;
  endedAt: Date;
  durationSec: number;
  totalEnergyKcal: number | null;
  totalDistanceM: number | null;
  avgHeartRate: number | null;
  maxHeartRate: number | null;
  minHeartRate: number | null;
}

/**
 * Read a finite number off a list of candidate paths (any sign), coercing int64
 * JSON strings, or null.
 */
function readNumber(
  point: GoogleHealthDataPoint,
  paths: string[],
): number | null {
  for (const path of paths) {
    const n = coerceNumber(readPath(point, path));
    if (n !== null) return n;
  }
  return null;
}

/**
 * Read an instant off a list of candidate paths, or null. Offset-less strings
 * resolve against `tz` (the user's stored zone) rather than the process zone;
 * strings carrying an explicit offset/`Z` are honoured as-is.
 */
function readInstant(
  point: GoogleHealthDataPoint,
  paths: string[],
  tz?: string,
): Date | null {
  for (const path of paths) {
    const v = readPath(point, path);
    if (typeof v === "string") {
      const d = parseLocalInstant(v, tz);
      if (d) return d;
    }
  }
  return null;
}

/**
 * Map one Google exercise session `DataPoint` into a `Workout` shape. Returns
 * null when there is no usable start/end (a session with no time span is not a
 * workout).
 *
 * Documented payload: `exercise.interval.startTime/endTime` (RFC-3339),
 * `exercise.exerciseType` (UPPERCASE enum), and
 * `exercise.metricsSummary.{caloriesKcal, distanceMillimeters,
 * averageHeartRateBeatsPerMinute (int64 string), …}`. There is no session-id
 * field — the DataPoint's top-level `name` (a resource name) is the stable id;
 * the start instant is the fallback. metricsSummary carries no max/min HR →
 * null.
 *
 * `exerciseType` leaves here twice: once mapped onto a canonical sport bucket,
 * once verbatim as `sportTypeRaw` so the ingest can keep the provenance.
 *
 * Session start/end can arrive OFFSET-LESS (local wall clock); `tz` anchors
 * them to the correct UTC instant rather than the process zone.
 */
export function mapWorkout(
  point: GoogleHealthDataPoint,
  tz?: string,
): GoogleHealthMappedWorkout | null {
  const k = GOOGLE_HEALTH_DATA_TYPES.exercise.key;
  const startedAt = readInstant(point, [`${k}.interval.startTime`], tz);
  const endedAt = readInstant(point, [`${k}.interval.endTime`], tz);
  if (!startedAt || !endedAt || endedAt <= startedAt) return null;

  const durationSec = Math.round(
    (endedAt.getTime() - startedAt.getTime()) / 1000,
  );

  const name = readPath(point, "name");
  const externalId =
    typeof name === "string" && name !== ""
      ? name
      : `exercise:${startedAt.toISOString()}`;

  const sportRaw = readPath(point, `${k}.exerciseType`);
  const sportTypeRaw =
    typeof sportRaw === "string" && sportRaw.trim() !== ""
      ? sportRaw.trim()
      : null;

  const energyKcal = readNumber(point, [`${k}.metricsSummary.caloriesKcal`]);
  const distanceMm = readNumber(point, [
    `${k}.metricsSummary.distanceMillimeters`,
  ]);
  const avgHr = readNumber(point, [
    `${k}.metricsSummary.averageHeartRateBeatsPerMinute`,
  ]);

  return {
    externalId,
    sportType: mapGoogleHealthSportType(sportRaw),
    sportTypeRaw,
    startedAt,
    endedAt,
    durationSec,
    totalEnergyKcal: energyKcal !== null ? Math.round(energyKcal) : null,
    totalDistanceM:
      distanceMm !== null && distanceMm >= 0
        ? importValue(distanceMm / 1000)
        : null,
    avgHeartRate: avgHr !== null && avgHr > 0 ? Math.round(avgHr) : null,
    // metricsSummary carries no maximum/minimum heart rate.
    maxHeartRate: null,
    minHeartRate: null,
  };
}
