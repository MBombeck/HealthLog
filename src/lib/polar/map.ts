/**
 * Polar records to measurement and workout rows: pure functions over the
 * wire shapes (`./wire-types.ts`), with no I/O, plus the parsing of an
 * exercise list body. `__tests__/map-fixtures.test.ts` pins what each makes of
 * sanitised fixtures.
 */
import { canonicalDailyTimestamp } from "@/lib/measurements/consolidation-tz";
import type { Prisma } from "@/generated/prisma/client";
import type { WorkoutSportType } from "@/lib/validations/workout";
import { mapPolarSportType } from "./sport-map";
import { importValue } from "@/lib/integrations/import-value";
import { reconstructContiguousSleepTimeline } from "@/lib/sleep/reconstruct-timeline";
import type {
  PolarNightlyRecharge,
  PolarSleep,
  PolarActivity,
  PolarCardioLoad,
  PolarSpo2,
  PolarExercise,
} from "./wire-types";

const SEC_TO_MIN = 1 / 60;

/** A single mapped reading destined for one `Measurement` row. The sync layer
 * stamps `source = POLAR` + `externalId = <resource>:<date>:<fieldTag>` unless
 * the mapper supplies its own full `externalId` (the per-segment sleep rows
 * need an index in the key). */
export interface MappedMeasurement {
  type: string;
  value: number;
  unit: string;
  measuredAt: Date;
  fieldTag: string;
  sleepStage?: "CORE" | "DEEP" | "REM" | "AWAKE" | "IN_BED";
  /**
   * Full externalId for rows the mapper keys itself rather than letting the
   * sync layer build `<resource>:<date>:<fieldTag>`. The reconstructed sleep
   * segments (one row per synthetic span) carry an index so the several rows of
   * one stage stay distinct under `userId_type_source_externalId`. When set the
   * sync layer uses it verbatim.
   */
  externalId?: string;
  /**
   * The calendar date a date-keyed row belongs to (`YYYY-MM-DD`). The sync
   * layer keys the externalId on it rather than on `measuredAt`, which sits at
   * the date's local noon in the user's zone and so can fall on a different
   * UTC date.
   */
  day?: string;
  /**
   * `true` on per-segment sleep rows whose ORDER is synthesised. When Polar
   * gives only per-stage duration totals (no per-stage onset timestamps), the
   * timeline is reconstructed in a fixed physiological order; the UI labels such
   * a night as an approximate layout and never presents it as measured timing.
   */
  reconstructed?: boolean;
}

/** A `nightly_recharge_status` is Polar's 1–6 recovery band; map it to a
 * 0–100 RECOVERY_SCORE so it feeds the canonical recovery ladder below WHOOP.
 * The status is the most stable recovery signal Polar exposes; we linearly
 * rescale 1–6 → 0–100 (1 = worst, 6 = best). */
function rechargeStatusToScore(status: number): number {
  const clamped = Math.max(1, Math.min(6, status));
  return importValue(((clamped - 1) / 5) * 100);
}

/**
 * Map one Polar Nightly Recharge record. The recovery band → `RECOVERY_SCORE`
 * (source POLAR, distinct from the COMPUTED proxy); HRV → `HRV_RMSSD`; the
 * nightly average HR → `RESTING_HEART_RATE`; breathing rate → `RESPIRATORY_RATE`.
 * `measuredAt` is the record's date anchored at local noon in the user's
 * zone (the wake morning the night belongs to).
 */
export function mapNightlyRecharge(
  r: PolarNightlyRecharge,
  tz?: string,
): MappedMeasurement[] {
  const measuredAt = canonicalDailyTimestamp(r.date, tz);
  if (Number.isNaN(measuredAt.getTime())) return [];
  const out: MappedMeasurement[] = [];

  if (typeof r.nightly_recharge_status === "number") {
    out.push({
      type: "RECOVERY_SCORE",
      value: rechargeStatusToScore(r.nightly_recharge_status),
      unit: "score",
      measuredAt,
      fieldTag: "recovery",
    });
  }
  if (
    typeof r.heart_rate_variability_avg === "number" &&
    r.heart_rate_variability_avg > 0
  ) {
    out.push({
      type: "HRV_RMSSD",
      value: importValue(r.heart_rate_variability_avg),
      unit: "ms",
      measuredAt,
      fieldTag: "hrv_rmssd",
    });
  }
  if (typeof r.heart_rate_avg === "number" && r.heart_rate_avg > 0) {
    out.push({
      type: "RESTING_HEART_RATE",
      value: Math.round(r.heart_rate_avg),
      unit: "bpm",
      measuredAt,
      fieldTag: "rhr",
    });
  }
  if (typeof r.breathing_rate_avg === "number" && r.breathing_rate_avg > 0) {
    out.push({
      type: "RESPIRATORY_RATE",
      value: importValue(r.breathing_rate_avg),
      unit: "breaths/min",
      measuredAt,
      fieldTag: "resp_rate",
    });
  }
  // ANS charge — the HRV-based autonomic-nervous-system component of Nightly
  // Recharge, Polar's primary differentiated recovery signal. It is a deviation
  // around the personal baseline (can be negative), so map it through as-is
  // rather than clamping like the 1–6 recovery band. `0` is a valid reading
  // (baseline), so guard on `number` only, not truthiness.
  if (typeof r.ans_charge === "number") {
    out.push({
      type: "ANS_CHARGE",
      value: importValue(r.ans_charge),
      unit: "score",
      measuredAt,
      fieldTag: "ans_charge",
    });
  }
  return out.map((m) => ({ ...m, day: r.date }));
}

/**
 * Map one Polar Sleep record into per-stage `SLEEP_DURATION` rows + the
 * `SLEEP_SCORE` percentage.
 *
 * `measuredAt` follows the END-instant convention every other sleep integration
 * uses (WHOOP/Withings/Fitbit) and that the canonical night-grouper
 * (`analytics/sleep-night.ts`) depends on: each stage segment is stamped at its
 * own END instant so the hypnogram has an ordered internal timeline and the
 * wake-day key resolves to the right LOCAL day even for negative-UTC users.
 *
 * Polar's sleep collection carries only per-stage DURATION totals plus the
 * night's `sleep_start_time` / `sleep_end_time` (ISO-8601 with local offset) —
 * no per-stage onset timestamps. So we RECONSTRUCT an ordered, contiguous
 * timeline exactly like WHOOP: lay the asleep stages back-to-back from
 * `sleep_start_time` in a fixed physiological order (CORE → DEEP → REM),
 * emitting one timed row per segment ending at the running cursor, and stamp the
 * `IN_BED` envelope + the score row at `sleep_end_time`. The ORDER is synthetic,
 * so every reconstructed segment is flagged `reconstructed: true` and keyed by
 * a stage-tagged externalId so the several rows of one night stay distinct.
 *
 * If the night carries no usable start/end (older records, missing fields) we
 * fall back to a midnight-UTC anchor and emit untimed stage rows — degraded but
 * never wrong-day for the common UTC-positive case, matching the pre-fix shape.
 */
export function mapSleep(s: PolarSleep, tz?: string): MappedMeasurement[] {
  const out: MappedMeasurement[] = [];

  const startMs = s.sleep_start_time ? Date.parse(s.sleep_start_time) : NaN;
  const endMs = s.sleep_end_time ? Date.parse(s.sleep_end_time) : NaN;
  const haveWindow =
    Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs;

  const stages: Array<
    [number | null | undefined, "CORE" | "DEEP" | "REM" | "AWAKE", string]
  > = [
    // AWAKE first — Polar reports the night's total interruption time, but no
    // per-stage onset. Lay it as a leading settling-in/awake block so the asleep
    // stages partition the remaining window and the night reader can surface a
    // real awakeMinutes / efficiency rather than reading the night as fully
    // consolidated. Matches WHOOP's leading-AWAKE ordering.
    [s.total_interruption_duration, "AWAKE", "sleep_awake"],
    [s.light_sleep, "CORE", "sleep_core"],
    [s.deep_sleep, "DEEP", "sleep_deep"],
    [s.rem_sleep, "REM", "sleep_rem"],
  ];

  if (haveWindow) {
    // Reconstructed timeline: lay each stage contiguously from onset, one timed
    // row per segment ending at the running cursor. The order is synthetic
    // (Polar gives no per-stage onset), so the shared builder flags every
    // segment reconstructed; the same algorithm backs WHOOP's `mapSleep`.
    out.push(
      ...reconstructContiguousSleepTimeline({
        startMs,
        stages: stages.map(([sec, stage, fieldTag]) => ({
          durationMs:
            typeof sec === "number" && Number.isFinite(sec) ? sec * 1000 : sec,
          stage,
          fieldTag,
        })),
        // IN_BED — single envelope row over the whole sleep window, stamped at
        // the sleep END so the in-bed reader resolves the span back to
        // [start, end].
        inBed: {
          durationMs: endMs - startMs,
          measuredAt: new Date(endMs),
          fieldTag: "sleep_in_bed",
        },
        // Stage-tagged externalId keeps the several segment rows of one night
        // distinct under userId_type_source_externalId (one segment per stage,
        // no positional index — an index renumbered on a re-score when a
        // stage's duration flipped 0↔positive, minting fresh ids that
        // double-counted the night).
        externalIdFor: (fieldTag) => `sleep:${s.date}:seg:${fieldTag}`,
      }),
    );

    if (typeof s.sleep_score === "number") {
      out.push({
        type: "SLEEP_PERFORMANCE",
        value: importValue(s.sleep_score),
        unit: "%",
        measuredAt: new Date(endMs),
        fieldTag: "sleep_score",
      });
    }
    return out;
  }

  // Fallback: no usable window. Anchor at local noon of the wake date and
  // emit untimed stage rows (the pre-v1.17.1 shape) so a record missing the
  // window fields still contributes a night total.
  const measuredAt = canonicalDailyTimestamp(s.date, tz);
  if (Number.isNaN(measuredAt.getTime())) return [];
  for (const [sec, stage, fieldTag] of stages) {
    if (typeof sec === "number" && sec >= 0) {
      out.push({
        type: "SLEEP_DURATION",
        value: importValue(sec * SEC_TO_MIN),
        unit: "minutes",
        measuredAt,
        fieldTag,
        sleepStage: stage,
      });
    }
  }
  if (typeof s.sleep_score === "number") {
    out.push({
      type: "SLEEP_PERFORMANCE",
      value: importValue(s.sleep_score),
      unit: "%",
      measuredAt,
      fieldTag: "sleep_score",
    });
  }
  return out.map((m) => ({ ...m, day: s.date }));
}

/** Map one current AccessLink daily-activity record: `steps` +
 * `active_calories` where Polar reports them. The active energy portion is
 * used instead of total `calories`, which includes BMR. */
export function mapActivity(
  a: PolarActivity,
  tz?: string,
): MappedMeasurement[] {
  if (typeof a.start_time !== "string") return [];
  const day = a.start_time.slice(0, 10);
  const measuredAt = canonicalDailyTimestamp(day, tz);
  if (Number.isNaN(measuredAt.getTime())) return [];
  const out: MappedMeasurement[] = [];
  const steps = a.steps;
  if (typeof steps === "number" && steps >= 0) {
    out.push({
      type: "ACTIVITY_STEPS",
      value: Math.round(steps),
      unit: "steps",
      measuredAt,
      fieldTag: "steps",
    });
  }
  const activeCalories = a.active_calories;
  if (typeof activeCalories === "number" && activeCalories >= 0) {
    out.push({
      type: "ACTIVE_ENERGY_BURNED",
      value: importValue(activeCalories),
      unit: "kcal",
      measuredAt,
      fieldTag: "active_energy",
    });
  }
  // Distance derived from steps, already in METRES (canonical SI for
  // WALKING_RUNNING_DISTANCE). Fills the POLAR slot the distance ladder already
  // ranks — previously a phantom entry with no producer.
  const distance = a.distance_from_steps;
  if (typeof distance === "number" && distance >= 0) {
    out.push({
      type: "WALKING_RUNNING_DISTANCE",
      value: importValue(distance),
      unit: "meters",
      measuredAt,
      fieldTag: "distance",
    });
  }
  return out.map((m) => ({ ...m, day }));
}

/** Map one Polar Training Load Pro record: `cardio_load` → `CARDIO_LOAD`
 * (Polar's device-native cardiovascular-strain figure). `0` is a valid load, so
 * guard on `number` only. */
export function mapCardioLoad(
  c: PolarCardioLoad,
  tz?: string,
): MappedMeasurement[] {
  const measuredAt = canonicalDailyTimestamp(c.date, tz);
  if (Number.isNaN(measuredAt.getTime())) return [];
  if (typeof c.cardio_load !== "number" || c.cardio_load < 0) return [];
  return [
    {
      type: "CARDIO_LOAD",
      value: importValue(c.cardio_load),
      unit: "score",
      measuredAt,
      fieldTag: "cardio_load",
      day: c.date,
    },
  ];
}

/** Map one Polar SpO2 test result: `blood_oxygen_percent` →
 * `OXYGEN_SATURATION` at the test's exact Unix timestamp. */
export function mapSpo2(r: PolarSpo2): MappedMeasurement[] {
  if (typeof r.test_time !== "number") return [];
  const measuredAt = new Date(r.test_time * 1000);
  if (Number.isNaN(measuredAt.getTime())) return [];
  const pct = r.blood_oxygen_percent;
  if (typeof pct !== "number" || pct <= 0 || pct > 100) return [];
  return [
    {
      type: "OXYGEN_SATURATION",
      value: importValue(pct),
      unit: "%",
      measuredAt,
      fieldTag: "spo2",
      externalId: `spo2:${r.test_time}:${r.source_device_id ?? "unknown"}`,
    },
  ];
}

/**
 * Candidate envelope keys the `/v3/exercises` list might nest under. The
 * verified shape (AccessLink swagger, 2026-07-24) is a BARE array covering the
 * last 30 days OF UPLOADS, with NO pagination token or page parameter — so the
 * bare-array branch is the live path. This tolerant key list is kept purely as
 * defense against a future envelope rename; when it engages (an object body
 * matching none of these keys), the fetch site logs a `polar.envelope.drift`
 * breadcrumb rather than silently reading empty.
 */
export const EXERCISE_LIST_KEYS = [
  "exercises",
  "data",
  "items",
  "records",
] as const;

/** Coerce a `/v3/exercises` body into a `PolarExercise[]`: a bare array, a
 *  paged envelope (list under one of `EXERCISE_LIST_KEYS`), or `[]` otherwise. */
export function normaliseExerciseList(json: unknown): PolarExercise[] {
  if (!json) return [];
  if (Array.isArray(json)) return json as PolarExercise[];
  if (typeof json === "object") {
    const obj = json as Record<string, unknown>;
    for (const key of EXERCISE_LIST_KEYS) {
      const list = obj[key];
      if (Array.isArray(list)) return list as PolarExercise[];
    }
  }
  return [];
}

// ─── Exercise → Workout mapping ────────────────────────────────

/** The `Workout`-row payload a mapped Polar exercise produces. Field names
 *  mirror `prisma.workout` columns; the sync layer stamps `source = POLAR` +
 *  `externalId` and upserts on `(userId, source, externalId)`. Mirrors
 *  `StravaWorkoutRow`. */
export interface PolarWorkoutRow {
  externalId: string;
  sportType: WorkoutSportType;
  startedAt: Date;
  endedAt: Date;
  durationSec: number;
  totalEnergyKcal: number | null;
  totalDistanceM: number | null;
  avgHeartRate: number | null;
  maxHeartRate: number | null;
  elevationM: number | null;
  metadata: Prisma.InputJsonValue;
}

function nonNegInt(n: number | null | undefined): number | null {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

function nonNegFloat(n: number | null | undefined): number | null {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return null;
  return n;
}

/** True when an ISO-8601 datetime string already carries a zone designator
 *  (`Z` or `±HH:MM` / `±HHMM`). Drives the two branches of start-time
 *  composition. */
function hasZoneDesignator(iso: string): boolean {
  return /(?:Z|[+-]\d{2}:?\d{2})$/.test(iso.trim());
}

/**
 * Combine Polar's `start_time` + `start_time_utc_offset` into the true UTC
 * instant.
 *
 * Two cases, because whether `start_time` carries a zone suffix is not verified
 * against the live payload:
 *   - It already has a zone (`…Z` / `…+02:00`): `Date.parse` yields the correct
 *     instant directly; the offset is NOT applied again.
 *   - No zone (a naive local wall-clock, the documented shape): interpret the
 *     wall-clock AS UTC (append `Z`), then subtract the offset minutes (east of
 *     UTC is positive) to recover the true instant. A missing / non-finite
 *     offset falls back to 0 (treat the wall-clock as UTC).
 *
 * Returns null for a missing / unparseable start (the row is skipped, mirroring
 * Strava's NaN-start guard).
 */
export function combinePolarStart(
  startTime: string | null | undefined,
  offsetMinutes: number | null | undefined,
): Date | null {
  if (typeof startTime !== "string" || startTime.trim() === "") return null;
  const trimmed = startTime.trim();
  if (hasZoneDesignator(trimmed)) {
    const ms = Date.parse(trimmed);
    return Number.isNaN(ms) ? null : new Date(ms);
  }
  const asUtcMs = Date.parse(`${trimmed}Z`);
  if (Number.isNaN(asUtcMs)) return null;
  const offset =
    typeof offsetMinutes === "number" && Number.isFinite(offsetMinutes)
      ? offsetMinutes
      : 0;
  return new Date(asUtcMs - offset * 60_000);
}

const ISO_DURATION_RE =
  /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i;

/**
 * Parse an ISO-8601 duration (`PT2H44M30S`, `PT45S`, `P1DT2H`, fractional
 * seconds allowed) to whole seconds. Malformed / empty input → 0, mirroring
 * Strava's `durationSec ?? 0` fallback so a bad duration never produces a
 * negative window. Hand-rolled — no new dependency.
 */
export function parseIsoDuration(raw: string | null | undefined): number {
  if (typeof raw !== "string") return 0;
  const m = ISO_DURATION_RE.exec(raw.trim());
  if (!m) return 0;
  const [, days, hours, minutes, seconds] = m;
  const total =
    (days ? parseFloat(days) * 86_400 : 0) +
    (hours ? parseFloat(hours) * 3_600 : 0) +
    (minutes ? parseFloat(minutes) * 60 : 0) +
    (seconds ? parseFloat(seconds) : 0);
  if (!Number.isFinite(total) || total < 0) return 0;
  return Math.round(total);
}

/**
 * Map one Polar exercise into a `Workout` row. `detailed_sport_info` is
 * preferred over the coarse `sport`, then mapped through `mapPolarSportType()`
 * to a canonical `WorkoutSportType` — the raw Polar labels are never written to
 * `sportType` directly (kept in `metadata` for provenance). `startedAt` is the
 * UTC instant recovered from `start_time` + `start_time_utc_offset`; `endedAt`
 * is `startedAt + durationSec` (Polar exposes no explicit end). `training_load`
 * rides `metadata` tied to this row (the WHOOP per-workout-strain precedent),
 * never a free-floating Measurement that would survive read-time dedup.
 *
 * Returns null for an exercise with no id or no parseable start instant
 * (nothing to store) — the sync layer skips it, never throws per-row.
 */
export function mapExercise(ex: PolarExercise): PolarWorkoutRow | null {
  if (ex.id === null || ex.id === undefined) return null;
  const externalId = String(ex.id);
  if (externalId.trim() === "") return null;

  const startedAt = combinePolarStart(ex.start_time, ex.start_time_utc_offset);
  if (!startedAt) return null;

  const durationSec = parseIsoDuration(ex.duration);
  const endedAt = new Date(startedAt.getTime() + durationSec * 1000);

  const sportType = mapPolarSportType(ex.detailed_sport_info, ex.sport);

  const avgHeartRate = nonNegInt(ex.heart_rate?.average);
  const maxHeartRate = nonNegInt(ex.heart_rate?.maximum);

  const metadata: Prisma.InputJsonValue = {
    // Raw pre-mapping labels, kept for provenance/debugging — never used as the
    // canonical `sportType` (see `mapPolarSportType()`).
    ...(ex.sport ? { polarSport: ex.sport } : {}),
    ...(ex.detailed_sport_info
      ? { polarDetailedSportInfo: ex.detailed_sport_info }
      : {}),
    ...(ex.device ? { polarDevice: ex.device } : {}),
    ...(ex.device_id ? { polarDeviceId: ex.device_id } : {}),
    ...(typeof ex.training_load === "number" &&
    Number.isFinite(ex.training_load)
      ? { trainingLoad: ex.training_load }
      : {}),
    ...(typeof ex.start_time_utc_offset === "number" &&
    Number.isFinite(ex.start_time_utc_offset)
      ? { startTimeUtcOffset: ex.start_time_utc_offset }
      : {}),
  };

  return {
    externalId,
    sportType,
    startedAt,
    endedAt,
    durationSec,
    totalEnergyKcal: nonNegFloat(ex.calories),
    totalDistanceM: nonNegFloat(ex.distance),
    avgHeartRate,
    maxHeartRate,
    // Not on the exercise summary — deriving it would require a GPX fetch
    // (out of scope). Left null.
    elevationM: null,
    metadata,
  };
}
