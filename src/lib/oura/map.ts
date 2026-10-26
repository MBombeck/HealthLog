/**
 * Oura records to measurement rows: pure functions over the wire shapes
 * (`./wire-types.ts`), with no I/O. `__tests__/map-fixtures.test.ts` pins what
 * each makes of sanitised fixtures.
 */
import { canonicalDailyTimestamp } from "@/lib/measurements/consolidation-tz";
import { dayDiff } from "@/lib/cycle/day-math";
import { importValue } from "@/lib/integrations/import-value";
import type {
  OuraSleep,
  OuraReadiness,
  OuraDailySleep,
  OuraDailySpo2,
  OuraVo2Max,
  OuraCardiovascularAge,
  OuraResilience,
  OuraCyclePhase,
  OuraDailyActivity,
  OuraHeartRateSample,
} from "./wire-types";

const SEC_TO_MIN = 1 / 60;

export interface MappedMeasurement {
  type: string;
  value: number;
  unit: string;
  measuredAt: Date;
  fieldTag: string;
  sleepStage?: "CORE" | "DEEP" | "REM" | "AWAKE";
  /**
   * Per-row externalId override. Most rows derive their externalId from the
   * resource prefix + day + fieldTag in the sync layer, but the per-segment
   * sleep-timeline rows (and any other row that needs a record-scoped key)
   * carry their own here so several rows of one night stay distinct under
   * `userId_type_source_externalId`. The sync layer uses `m.externalId ??`
   * the default key.
   */
  externalId?: string;
}

function dayAnchor(
  day: string,
  tz: string | undefined,
  bedtimeEnd?: string,
): Date | null {
  // Prefer the precise wake instant when present; else anchor the date-only
  // day at local noon in the user's zone (canonicalDailyTimestamp), which
  // reads the same calendar day there. Noon UTC, the previous anchor, is
  // already the next day from UTC+13 on.
  if (bedtimeEnd) {
    const d = new Date(bedtimeEnd);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = canonicalDailyTimestamp(day, tz);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Map one Oura readiness record:
 *   - `score` → `RECOVERY_SCORE` (source OURA, feeding the recovery ladder
 *     below WHOOP).
 *   - `temperature_deviation` → `BODY_TEMPERATURE_DEVIATION` (signed °C offset
 *     from the personal baseline — illness / luteal-phase / stress signal).
 *
 * The eight readiness `contributors` are the *why* behind the score; they are
 * carried back to the caller separately (not minted as Measurement rows here
 * since each is a sub-score, not a stored metric) — see the dropped-field note.
 * `temperature_trend_deviation` is the long-term trend twin; we keep only the
 * nightly deviation as the actionable signal.
 */
export function mapReadiness(
  r: OuraReadiness,
  tz?: string,
): MappedMeasurement[] {
  const measuredAt = dayAnchor(r.day, tz, r.timestamp);
  if (!measuredAt) return [];
  const out: MappedMeasurement[] = [];
  if (typeof r.score === "number") {
    out.push({
      type: "RECOVERY_SCORE",
      value: importValue(r.score),
      unit: "score",
      measuredAt,
      fieldTag: "recovery",
    });
  }
  if (typeof r.temperature_deviation === "number") {
    out.push({
      type: "BODY_TEMPERATURE_DEVIATION",
      value: importValue(r.temperature_deviation),
      unit: "celsius",
      measuredAt,
      fieldTag: "temp_deviation",
    });
  }
  return out;
}

/**
 * Oura 5-minute hypnogram digit → our `SleepStage`. Oura encodes one digit per
 * 5-min interval from `bedtime_start`: `1`=deep, `2`=light, `3`=rem, `4`=awake.
 * Light maps to our CORE stage (the granular-asleep stage the sleep-night
 * reader scores), matching the `light_sleep_duration → CORE` convention the
 * stage-totals path already uses. Re-verify against `cloud.ouraring.com/v2/docs`.
 */
const HYPNOGRAM_STAGE: Record<
  string,
  NonNullable<MappedMeasurement["sleepStage"]>
> = {
  "1": "DEEP",
  "2": "CORE",
  "3": "REM",
  "4": "AWAKE",
};

/** Each hypnogram digit covers 5 minutes. */
const HYPNOGRAM_INTERVAL_MIN = 5;

const HYPNOGRAM_INTERVAL_MS = HYPNOGRAM_INTERVAL_MIN * 60_000;

/**
 * Build timed per-segment `SLEEP_DURATION` rows from Oura's real measured
 * `sleep_phase_5_min` hypnogram. Consecutive identical digits collapse into one
 * segment; each segment is stamped at its own END instant (start + duration)
 * relative to `bedtime_start`, so the sleep-night reader (which derives
 * `start = end − value·60_000`) reconstructs the actual clock-time timeline —
 * NOT the degraded all-on-`bedtime_end` shape. The rows are `reconstructed:
 * false` by virtue of OURA being absent from the reader's
 * `RECONSTRUCTED_TIMELINE_SOURCES` set (WHOOP only). Returns `null` when the
 * hypnogram is absent / unusable so the caller falls back to stage totals.
 */
function mapSleepTimeline(s: OuraSleep): MappedMeasurement[] | null {
  const hyp = s.sleep_phase_5_min;
  if (typeof hyp !== "string" || hyp.length === 0 || !s.bedtime_start) {
    return null;
  }
  const onset = new Date(s.bedtime_start);
  if (Number.isNaN(onset.getTime())) return null;

  const out: MappedMeasurement[] = [];
  let i = 0;
  while (i < hyp.length) {
    const digit = hyp[i];
    const stage = HYPNOGRAM_STAGE[digit];
    // Walk the run of identical digits.
    let run = 1;
    while (i + run < hyp.length && hyp[i + run] === digit) run += 1;
    if (stage) {
      const segStartMs = onset.getTime() + i * HYPNOGRAM_INTERVAL_MS;
      const segEndMs = segStartMs + run * HYPNOGRAM_INTERVAL_MS;
      // Keyed by the run's own START instant, NOT a positional run index. A
      // revised hypnogram re-segments the night (runs merge/split), so an
      // index shifted every following run onto the wrong row — wrong
      // boundaries updated in place plus phantom tail rows the night-total
      // double-counted. A run's start instant is a stable coordinate: an
      // unchanged run keeps its id (re-classification overwrites in place),
      // and whatever the revision orphaned is swept by the record-scoped
      // cleanup in the sync (which also clears legacy `seg:<i>` rows).
      const fieldTag = `seg:${new Date(segStartMs).toISOString()}`;
      out.push({
        type: "SLEEP_DURATION",
        value: importValue(run * HYPNOGRAM_INTERVAL_MIN),
        unit: "minutes",
        measuredAt: new Date(segEndMs),
        fieldTag,
        sleepStage: stage,
        // Record-scoped so a nap's segments never collide with the main
        // sleep's and a re-fetch overwrites in place.
        externalId: `sleep:${s.id}:${fieldTag}`,
      });
    }
    i += run;
  }
  return out.length > 0 ? out : null;
}

/**
 * Oura sleep periods that are not sleep. Oura's `type` marks a detected period
 * the person turned down in the app's confirm prompt as `rest` ("falsely
 * detected sleep / nap, rejected by the user") and one they deleted as
 * `deleted`; the sleep collection still returns both. Importing them made an
 * afternoon on the sofa a second sleep session on that day, which added its
 * minutes to the night and pulled the night's midpoint into the afternoon.
 * `sleep`, `long_sleep` and `late_nap` are periods Oura counts, and an unknown
 * or missing type stays in, as before.
 */
const RETIRED_OURA_SLEEP_TYPES: ReadonlySet<string> = new Set([
  "rest",
  "deleted",
]);

/** True for an Oura sleep period the person rejected or deleted. */
export function isRetiredOuraSleepPeriod(s: Pick<OuraSleep, "type">): boolean {
  return typeof s.type === "string" && RETIRED_OURA_SLEEP_TYPES.has(s.type);
}

/**
 * Map one Oura sleep record. A rejected or deleted period
 * (`isRetiredOuraSleepPeriod`) maps to nothing. When the real `sleep_phase_5_min` hypnogram is
 * present we emit timed per-segment `SLEEP_DURATION` rows (Oura's measured
 * timeline); otherwise we fall back to the four per-stage totals stamped on the
 * sleep END. Either way we add efficiency, HRV, RHR (`lowest_heart_rate`), and
 * respiratory rate.
 */
export function mapSleep(s: OuraSleep, tz?: string): MappedMeasurement[] {
  if (isRetiredOuraSleepPeriod(s)) return [];
  const measuredAt = dayAnchor(s.day, tz, s.bedtime_end);
  if (!measuredAt) return [];
  const out: MappedMeasurement[] = [];

  const timeline = mapSleepTimeline(s);
  if (timeline) {
    out.push(...timeline);
  } else {
    // Fallback: no hypnogram — stamp the four stage totals on the sleep END.
    const stages: Array<
      [number | null | undefined, MappedMeasurement["sleepStage"], string]
    > = [
      [s.light_sleep_duration, "CORE", "sleep_core"],
      [s.deep_sleep_duration, "DEEP", "sleep_deep"],
      [s.rem_sleep_duration, "REM", "sleep_rem"],
      [s.awake_time, "AWAKE", "sleep_awake"],
    ];
    for (const [sec, stage, fieldTag] of stages) {
      if (typeof sec === "number" && sec >= 0) {
        out.push({
          type: "SLEEP_DURATION",
          value: importValue(sec * SEC_TO_MIN),
          unit: "minutes",
          measuredAt,
          fieldTag,
          sleepStage: stage,
          // Record-scoped so a nap and the main sleep on the same day don't
          // collapse onto one key (B2) — the legacy day-keyed key did.
          externalId: `sleep:${s.id}:${fieldTag}`,
        });
      }
    }
  }
  // The nightly scalars are record-scoped too (B2): a nap and the main sleep on
  // the same day would otherwise overwrite each other's efficiency / HRV / RHR /
  // respiratory rate on a shared day key.
  if (typeof s.efficiency === "number") {
    out.push({
      type: "SLEEP_EFFICIENCY",
      value: importValue(s.efficiency),
      unit: "%",
      measuredAt,
      fieldTag: "sleep_eff",
      externalId: `sleep:${s.id}:sleep_eff`,
    });
  }
  if (typeof s.average_hrv === "number" && s.average_hrv > 0) {
    out.push({
      type: "HRV_RMSSD",
      value: importValue(s.average_hrv),
      unit: "ms",
      measuredAt,
      fieldTag: "hrv_rmssd",
      externalId: `sleep:${s.id}:hrv_rmssd`,
    });
  }
  if (typeof s.lowest_heart_rate === "number" && s.lowest_heart_rate > 0) {
    out.push({
      type: "RESTING_HEART_RATE",
      value: Math.round(s.lowest_heart_rate),
      unit: "bpm",
      measuredAt,
      fieldTag: "rhr",
      externalId: `sleep:${s.id}:rhr`,
    });
  }
  if (typeof s.average_breath === "number" && s.average_breath > 0) {
    out.push({
      type: "RESPIRATORY_RATE",
      value: importValue(s.average_breath),
      unit: "breaths/min",
      measuredAt,
      fieldTag: "resp_rate",
      externalId: `sleep:${s.id}:resp_rate`,
    });
  }
  return out;
}

/** Map one Oura daily-sleep record: the headline Sleep Score → `SLEEP_SCORE`. */
export function mapDailySleep(
  d: OuraDailySleep,
  tz?: string,
): MappedMeasurement[] {
  if (typeof d.score !== "number") return [];
  const measuredAt = dayAnchor(d.day, tz, d.timestamp);
  if (!measuredAt) return [];
  return [
    {
      type: "SLEEP_SCORE",
      value: importValue(d.score),
      unit: "score",
      measuredAt,
      fieldTag: "sleep_score",
    },
  ];
}

/** Map one Oura daily-spo2 record: average overnight SpO2 → `OXYGEN_SATURATION`. */
export function mapDailySpo2(
  s: OuraDailySpo2,
  tz?: string,
): MappedMeasurement[] {
  const avg = s.spo2_percentage?.average;
  if (typeof avg !== "number" || avg <= 0) return [];
  // Anchor SpO2 at the day's local noon (no per-record instant in the
  // daily_spo2 collection); the recovery / rollup readers key off the local day.
  const measuredAt = dayAnchor(s.day, tz);
  if (!measuredAt) return [];
  return [
    {
      type: "OXYGEN_SATURATION",
      value: importValue(avg),
      unit: "%",
      measuredAt,
      fieldTag: "spo2",
    },
  ];
}

/**
 * Map one Oura daily-activity record: steps and active energy.
 *
 * `equivalent_walking_distance` is deliberately not mapped. Oura derives it
 * from the day's whole activity (the distance a walk of the same effort would
 * have covered), so an hour of cycling or yoga adds kilometres nobody walked.
 * Stored as `WALKING_RUNNING_DISTANCE` it read as real distance, and on a day
 * no other source covered it became the day's distance. The rows earlier
 * syncs wrote under `activity:<day>:distance` are retired on their own
 * (`./retire-distance`).
 */
export function mapDailyActivity(
  a: OuraDailyActivity,
  tz?: string,
): MappedMeasurement[] {
  const measuredAt = dayAnchor(a.day, tz, a.timestamp);
  if (!measuredAt) return [];
  const out: MappedMeasurement[] = [];
  if (typeof a.steps === "number" && a.steps >= 0) {
    out.push({
      type: "ACTIVITY_STEPS",
      value: Math.round(a.steps),
      unit: "steps",
      measuredAt,
      fieldTag: "steps",
    });
  }
  if (typeof a.active_calories === "number" && a.active_calories >= 0) {
    out.push({
      type: "ACTIVE_ENERGY_BURNED",
      value: importValue(a.active_calories),
      unit: "kcal",
      measuredAt,
      fieldTag: "active_energy",
    });
  }
  return out;
}

/**
 * Map one Oura `vO2_max` record: the dedicated cardio-fitness collection →
 * `VO2_MAX` (mL/(kg·min), the canonical DB unit — no conversion). Skips a
 * record with no positive value.
 */
export function mapVo2Max(v: OuraVo2Max, tz?: string): MappedMeasurement[] {
  if (typeof v.vo2_max !== "number" || v.vo2_max <= 0) return [];
  const measuredAt = dayAnchor(v.day, tz, v.timestamp);
  if (!measuredAt) return [];
  return [
    {
      type: "VO2_MAX",
      value: importValue(v.vo2_max),
      unit: "mL/(kg·min)",
      measuredAt,
      fieldTag: "vo2_max",
    },
  ];
}

/**
 * Map one Oura `daily_cardiovascular_age` record → `VASCULAR_AGE` (years, the
 * canonical DB unit — no conversion). Skips a record with no positive value.
 * Shares the `VASCULAR_AGE` bucket with Withings' Body Scan arterial-age, kept
 * distinct from the two vendors only by `source`.
 */
export function mapCardiovascularAge(
  c: OuraCardiovascularAge,
  tz?: string,
): MappedMeasurement[] {
  if (typeof c.vascular_age !== "number" || c.vascular_age <= 0) return [];
  const measuredAt = dayAnchor(c.day, tz);
  if (!measuredAt) return [];
  return [
    {
      type: "VASCULAR_AGE",
      value: importValue(c.vascular_age),
      unit: "years",
      measuredAt,
      fieldTag: "vascular_age",
    },
  ];
}

/**
 * Single source of truth for the Oura resilience level → ordinal encoding.
 * Oura's `daily_resilience.level` is a categorical band; we store it ORDINAL-
 * ENCODED in the numeric Measurement `value` so it fits the existing model with
 * no new categorical column. Keep in lock-step with the schema comment on the
 * `RESILIENCE` enum value and migration 0186.
 */
export const RESILIENCE_LEVELS: Record<string, number> = {
  limited: 1,
  adequate: 2,
  solid: 3,
  strong: 4,
  exceptional: 5,
};

/** The unit recorded for a RESILIENCE row — the ordinal level scale (1–5). */
export const RESILIENCE_UNIT = "level" as const;

/**
 * Map one Oura `daily_resilience` record → `RESILIENCE`, ordinal-encoded
 * (limited=1 … exceptional=5) into the numeric `value`. An unknown / missing
 * level string mints NO row (skipped, never coerced to 0) so a future Oura band
 * we do not recognise never lands as a misleading reading. Anchored at the
 * day's local noon (the collection carries no per-record instant).
 */
export function mapResilience(
  r: OuraResilience,
  tz?: string,
): MappedMeasurement[] {
  const level = typeof r.level === "string" ? r.level.toLowerCase() : null;
  if (!level) return [];
  const ordinal = RESILIENCE_LEVELS[level];
  if (typeof ordinal !== "number") return [];
  const measuredAt = dayAnchor(r.day, tz);
  if (!measuredAt) return [];
  return [
    {
      type: "RESILIENCE",
      value: ordinal,
      unit: RESILIENCE_UNIT,
      measuredAt,
      fieldTag: "resilience",
    },
  ];
}

/** Heart-rate readings outside this band are not a ring's reading. */
const OURA_BPM_MIN = 20;

const OURA_BPM_MAX = 250;

/**
 * Map one `heartrate` sample → `PULSE` (bpm), the intraday heart-rate type
 * Google Health and Fitbit write their minute stream to. Keyed on the
 * sample's own instant (`heartrate:<ISO>`): Oura emits one reading per
 * instant, and a sample is final once it is in the cloud, so a re-read lands
 * on the same key. A sample without a parseable instant or with a bpm
 * outside a human band maps to nothing.
 */
export function mapHeartRateSample(
  sample: OuraHeartRateSample,
): MappedMeasurement | null {
  const bpm = sample.bpm;
  if (typeof bpm !== "number" || !Number.isFinite(bpm)) return null;
  if (bpm < OURA_BPM_MIN || bpm > OURA_BPM_MAX) return null;
  if (typeof sample.timestamp !== "string") return null;
  const at = new Date(sample.timestamp);
  if (Number.isNaN(at.getTime())) return null;
  const iso = at.toISOString();
  return {
    type: "PULSE",
    value: Math.round(bpm),
    unit: "bpm",
    measuredAt: at,
    fieldTag: "hr",
    externalId: `heartrate:${iso}`,
  };
}

// ─── Cycle-phase → CycleDayLog mapping (v1.29.x) ───────────────────
//
// `daily_cycle_phases` does NOT feed `Measurement` like every collection
// above — it feeds the cycle tracker's `CycleDayLog` via
// `syncUserOuraCyclePhases` in `./cycle-sync`, which owns the write-side
// "manual always wins" guard. This module only derives WHICH days look like
// a period day; it never touches the database.

const OURA_MENSTRUAL_PHASE = "menstrual";

const OURA_FOLLICULAR_PHASE = "follicular";

const OURA_LUTEAL_PHASE = "luteal";

/**
 * Derive the (sparse) set of `YYYY-MM-DD` days that look like a period day
 * from a `daily_cycle_phases` series. The endpoint reports only the PHASE,
 * not menstrual flow directly, so a period day is inferred two ways:
 *
 *   1. A record whose `phase` is literally `"menstrual"` — some algorithm
 *      versions / accounts may emit this directly.
 *   2. The single day a `"luteal"` phase is immediately (calendar-adjacent)
 *      followed by a `"follicular"` phase. Oura's own definition of the
 *      follicular phase is "from the first day of menstruation to
 *      ovulation", so this transition day is the best period-start signal
 *      the two-phase (follicular/luteal) shape carries.
 *
 * Records are sorted by `day` internally (the collection's page order is not
 * guaranteed to be chronological). Returns bare day strings — the caller
 * writes each as a single-day conservative `flow: LIGHT` marker (the same
 * "logged but unspecified intensity" boundary the HealthKit `unspecified`
 * flow mapping uses), never a multi-day bleed span this endpoint gives no
 * evidence for.
 */
export function derivePeriodDaysFromCyclePhases(
  records: readonly OuraCyclePhase[],
): string[] {
  const sorted = [...records]
    .filter((r) => typeof r.day === "string" && r.day.length > 0)
    .sort((a, b) => dayDiff(a.day, b.day));

  const days = new Set<string>();
  let prevPhase: string | null = null;
  let prevDay: string | null = null;

  for (const r of sorted) {
    const phase = typeof r.phase === "string" ? r.phase.toLowerCase() : null;

    if (phase === OURA_MENSTRUAL_PHASE) {
      days.add(r.day);
    } else if (
      phase === OURA_FOLLICULAR_PHASE &&
      prevPhase === OURA_LUTEAL_PHASE &&
      prevDay !== null &&
      dayDiff(r.day, prevDay) === 1
    ) {
      days.add(r.day);
    }

    if (phase) {
      prevPhase = phase;
      prevDay = r.day;
    }
  }

  return Array.from(days);
}
