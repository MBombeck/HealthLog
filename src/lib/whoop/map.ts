/**
 * WHOOP records to measurement rows: pure functions over the wire shapes
 * (`./wire-types.ts`), with no I/O, and the field map kept in sync with
 * `./mapping.md`. `__tests__/map-fixtures.test.ts` pins what each makes of
 * sanitised fixtures.
 */
import { importValue } from "@/lib/integrations/import-value";
import type {
  WhoopRecovery,
  WhoopSleep,
  WhoopCycle,
  WhoopBodyMeasurement,
} from "./wire-types";
import { reconstructContiguousSleepTimeline } from "@/lib/sleep/reconstruct-timeline";

// ─── Field → Measurement mapping ───────────────────────────────
// The single source of truth is `src/lib/whoop/mapping.md` — keep both in
// sync when adding entries.

/** Milliseconds → minutes. */
const MS_TO_MIN = 1 / 60_000;

/** Kilojoules → kilocalories (workout energy). */
export const KJ_TO_KCAL = 1 / 4.184;

/**
 * A single mapped reading destined for one `Measurement` row. The `source`
 * (`WHOOP`) and `externalId` (`<resource-uuid>:<fieldTag>`) are stamped by the
 * sync layer (W3); the mapper only emits the type/value/unit/measuredAt and
 * the field-tag that disambiguates the several rows derived from one resource.
 */
export interface MappedMeasurement {
  type: string;
  value: number;
  unit: string;
  measuredAt: Date;
  /** Disambiguator appended to the resource uuid to form the externalId. */
  fieldTag: string;
  /** Per-stage sleep rows carry the SleepStage; everything else omits it. */
  sleepStage?: "CORE" | "DEEP" | "REM" | "AWAKE" | "IN_BED";
  /**
   * Full externalId for rows the mapper must key itself rather than letting
   * the sync layer build `<resource-uuid>:<fieldTag>`. The reconstructed sleep
   * segments (one row per synthetic span) need an index in the key so the
   * several rows of one stage stay distinct under
   * `userId_type_source_externalId`. When set the sync layer uses it verbatim.
   */
  externalId?: string;
  /**
   * `true` on the synthesised per-segment sleep rows whose ORDER is invented:
   * WHOOP's v2 API returns only per-stage duration totals (no onset
   * timestamps), so the timeline is reconstructed in a fixed physiological
   * order. The night is flagged so the UI labels it as an approximate layout
   * and never presents it as measured stage timing.
   */
  reconstructed?: boolean;
}

/**
 * Every field-tag `mapRecovery` can emit. A recovery's rows are keyed
 * `<sleep_id>:<fieldTag>` and share the `<sleep_id>:` prefix with the rows of
 * the sleep it belongs to, so a recovery deletion must name these exact ids
 * rather than match on the prefix (which would take the night's sleep rows
 * with it). Pinned against the mapper by a test.
 */
export const WHOOP_RECOVERY_FIELD_TAGS = [
  "recovery",
  "hrv_rmssd",
  "rhr",
  "spo2",
  "skin_temp",
] as const;

/**
 * Map one WHOOP recovery record into Measurement readings. An unscored record
 * (`score === null`) yields nothing. `recovery.score.recovery_score` →
 * `RECOVERY_SCORE` (source WHOOP, distinct from the COMPUTED proxy);
 * `hrv_rmssd_milli` → `HRV_RMSSD` (distinct from the SDNN
 * `HEART_RATE_VARIABILITY`); RHR / SpO2 / skin-temp resolve through the
 * cross-source picker.
 */
export function mapRecovery(r: WhoopRecovery): MappedMeasurement[] {
  if (!r.score) return [];
  const measuredAt = new Date(r.updated_at);
  const out: MappedMeasurement[] = [
    {
      type: "RECOVERY_SCORE",
      value: importValue(r.score.recovery_score),
      unit: "score",
      measuredAt,
      fieldTag: "recovery",
    },
    {
      type: "HRV_RMSSD",
      value: importValue(r.score.hrv_rmssd_milli),
      unit: "ms",
      measuredAt,
      fieldTag: "hrv_rmssd",
    },
    {
      type: "RESTING_HEART_RATE",
      value: importValue(r.score.resting_heart_rate),
      unit: "bpm",
      measuredAt,
      fieldTag: "rhr",
    },
  ];
  if (typeof r.score.spo2_percentage === "number") {
    out.push({
      type: "OXYGEN_SATURATION",
      value: importValue(r.score.spo2_percentage),
      unit: "%",
      measuredAt,
      fieldTag: "spo2",
    });
  }
  if (typeof r.score.skin_temp_celsius === "number") {
    out.push({
      type: "SKIN_TEMPERATURE",
      value: importValue(r.score.skin_temp_celsius),
      unit: "celsius",
      measuredAt,
      fieldTag: "skin_temp",
    });
  }
  return out;
}

/**
 * Map one WHOOP sleep record into Measurement readings: per-stage
 * `SLEEP_DURATION` rows (ms→min, one per stage), `SLEEP_NEED` (ms→min, summed
 * components), the `SLEEP_*` percentage scores, and `RESPIRATORY_RATE`.
 */
export function mapSleep(s: WhoopSleep): MappedMeasurement[] {
  if (!s.score) return [];
  const measuredAt = new Date(s.end);
  const out: MappedMeasurement[] = [];

  const stages = s.score.stage_summary;

  // WHOOP v2 returns only per-stage DURATION totals (no per-stage onset
  // timestamps, no hypnogram endpoint). Stamping every stage total on the one
  // sleep-END instant makes the hypnogram reconstruct five spans that all touch
  // the night's right edge (the stacked-bar artefact). Since the API never
  // carries an order, we RECONSTRUCT an ordered, contiguous timeline: lay the
  // asleep stages back-to-back from sleep ONSET in a fixed physiological order,
  // emitting one timed row per segment with `measuredAt = that segment's END`.
  // The ORDER is synthetic, so every reconstructed row is flagged
  // `reconstructed: true` and the night DTO advertises it — the UI labels it as
  // an approximate layout and never presents it as measured stage timing.
  //
  // IN_BED stays a single envelope row spanning the whole [start, end] window:
  // the in-bed reader wants the union envelope, not a placed segment. AWAKE is
  // laid as a leading segment from onset so the asleep stages still partition
  // the remaining window.
  const onset = new Date(s.start).getTime();
  // Order the laid-out stages: a brief AWAKE settling-in block, then the asleep
  // stages CORE → DEEP → REM. Each carries its own duration; the shared builder
  // walks the cursor forward so the spans are contiguous and non-overlapping,
  // and lays the IN_BED envelope over the whole window. The order is synthetic
  // (WHOOP gives no per-stage onset), so every laid segment is flagged
  // reconstructed; the same algorithm backs Polar's `mapSleep`.
  out.push(
    ...reconstructContiguousSleepTimeline({
      startMs: onset,
      stages: [
        {
          durationMs: stages.total_awake_time_milli,
          stage: "AWAKE",
          fieldTag: "sleep_awake",
        },
        {
          durationMs: stages.total_light_sleep_time_milli,
          stage: "CORE",
          fieldTag: "sleep_core",
        },
        {
          durationMs: stages.total_slow_wave_sleep_time_milli,
          stage: "DEEP",
          fieldTag: "sleep_deep",
        },
        {
          durationMs: stages.total_rem_sleep_time_milli,
          stage: "REM",
          fieldTag: "sleep_rem",
        },
      ],
      // IN_BED — single envelope row over the whole sleep window. `measuredAt`
      // is the sleep END so `segmentOf` resolves the span back to [start, end];
      // the in-bed union-envelope reader consumes the full window.
      inBed: {
        durationMs: stages.total_in_bed_time_milli,
        measuredAt,
        fieldTag: "sleep_in_bed",
      },
      // The sync layer keys reconstructed rows by this externalId verbatim;
      // the stage tag keeps the several rows of one night distinct under
      // userId_type_source_externalId (one segment per stage, no positional
      // index — an index renumbered on a re-score when a stage's duration
      // flipped 0↔positive, minting fresh ids that double-counted the night).
      externalIdFor: (tag) => `${s.id}:seg:${tag}`,
    }),
  );

  const need = s.score.sleep_needed;
  const totalNeedMilli =
    need.baseline_milli +
    need.need_from_sleep_debt_milli +
    need.need_from_recent_strain_milli +
    need.need_from_recent_nap_milli;
  out.push({
    type: "SLEEP_NEED",
    value: importValue(totalNeedMilli * MS_TO_MIN),
    unit: "minutes",
    measuredAt,
    fieldTag: "sleep_need",
  });

  const pct: Array<[string, number | undefined, string]> = [
    ["SLEEP_PERFORMANCE", s.score.sleep_performance_percentage, "sleep_perf"],
    ["SLEEP_EFFICIENCY", s.score.sleep_efficiency_percentage, "sleep_eff"],
    [
      "SLEEP_CONSISTENCY",
      s.score.sleep_consistency_percentage,
      "sleep_consistency",
    ],
  ];
  for (const [type, value, fieldTag] of pct) {
    if (typeof value === "number") {
      out.push({
        type,
        value: importValue(value),
        unit: "%",
        measuredAt,
        fieldTag,
      });
    }
  }

  if (typeof s.score.respiratory_rate === "number") {
    out.push({
      type: "RESPIRATORY_RATE",
      value: importValue(s.score.respiratory_rate),
      unit: "breaths/min",
      measuredAt,
      fieldTag: "resp_rate",
    });
  }

  if (typeof stages.disturbance_count === "number") {
    out.push({
      type: "SLEEP_DISTURBANCE_COUNT",
      value: stages.disturbance_count,
      unit: "count",
      measuredAt,
      fieldTag: "disturbances",
    });
  }

  return out;
}

/**
 * Map one WHOOP cycle (day) record: `DAY_STRAIN` (distinct from the COMPUTED
 * `STRAIN_SCORE`), `ENERGY_EXPENDITURE_KJ` (kept in native kJ), and the day's
 * whole-cycle `AVERAGE_HEART_RATE` / `MAX_HEART_RATE`. Energy is NOT converted
 * to kcal here — that conversion is for the workout path only.
 */
export function mapCycle(c: WhoopCycle): MappedMeasurement[] {
  if (!c.score) return [];
  const measuredAt = new Date(c.start);
  const out: MappedMeasurement[] = [
    {
      type: "DAY_STRAIN",
      value: importValue(c.score.strain),
      unit: "score",
      measuredAt,
      fieldTag: "day_strain",
    },
    {
      type: "ENERGY_EXPENDITURE_KJ",
      value: importValue(c.score.kilojoule),
      unit: "kJ",
      measuredAt,
      fieldTag: "energy_kj",
    },
  ];

  // The cycle score's average and max heart rate. Distinct fieldTags keep them
  // from colliding with the strain and energy rows under the shared cycle
  // `externalId`.
  if (typeof c.score.average_heart_rate === "number") {
    out.push({
      type: "AVERAGE_HEART_RATE",
      value: Math.round(c.score.average_heart_rate),
      unit: "bpm",
      measuredAt,
      fieldTag: "avg_hr",
    });
  }
  if (typeof c.score.max_heart_rate === "number") {
    out.push({
      type: "MAX_HEART_RATE",
      value: Math.round(c.score.max_heart_rate),
      unit: "bpm",
      measuredAt,
      fieldTag: "max_hr",
    });
  }

  return out;
}

/** Metres → centimetres (WHOOP `height_meter` → `User.heightCm`). */
const M_TO_CM = 100;

/**
 * The three destinations a WHOOP body-measurement object fans out to. Unlike
 * the collection mappers it does NOT emit `MappedMeasurement[]` directly,
 * because only `weight` lands in `Measurement` — `maxHeartRate` is a profile
 * constant on `WhoopConnection` and `heightCm` is a one-time `User` profile
 * seed (written only when the user has no height yet). The sync layer routes
 * each piece to its own table.
 */
export interface MappedBodyMeasurement {
  /** Self-reported profile weight in kg, or null when WHOOP omits it. */
  weightKg: number | null;
  /** Profile max heart rate in bpm, or null when WHOOP omits it. */
  maxHeartRate: number | null;
  /** Profile height converted m→cm, or null when WHOOP omits it. */
  heightCm: number | null;
}

/**
 * Map a WHOOP body-measurement object onto its three destinations. The body
 * measurement is a single self-reported profile value, not a timestamped
 * reading, so the sync layer stamps the weight row's `measuredAt` with the
 * fetch time. Every field is optional on the wire — an absent field maps to
 * null and the sync layer skips it.
 */
export function mapBody(b: WhoopBodyMeasurement): MappedBodyMeasurement {
  // WHOOP body fields are self-reported profile data. Guard against absent,
  // non-finite (NaN/Infinity), or non-positive values so a garbage reading
  // never seeds a real WEIGHT measurement or a `User.heightCm` of 0.
  const positive = (n: number | undefined): n is number =>
    typeof n === "number" && Number.isFinite(n) && n > 0;
  return {
    weightKg: positive(b.weight_kilogram)
      ? importValue(b.weight_kilogram)
      : null,
    maxHeartRate: positive(b.max_heart_rate)
      ? Math.round(b.max_heart_rate)
      : null,
    heightCm: positive(b.height_meter)
      ? importValue(b.height_meter * M_TO_CM)
      : null,
  };
}

/**
 * Field→Measurement mapping table (mirror of `mapping.md`). Documents which
 * WHOOP source field becomes which MeasurementType + unit. Used as the
 * single-glance reference and by the mapper tests; the mappers above are the
 * executable form.
 */
export const WHOOP_FIELD_MAP: Record<
  string,
  { type: string; unit: string; factor?: number; note?: string }
> = {
  "recovery.score.recovery_score": { type: "RECOVERY_SCORE", unit: "score" },
  "recovery.score.hrv_rmssd_milli": { type: "HRV_RMSSD", unit: "ms" },
  "recovery.score.resting_heart_rate": {
    type: "RESTING_HEART_RATE",
    unit: "bpm",
  },
  "recovery.score.spo2_percentage": {
    type: "OXYGEN_SATURATION",
    unit: "%",
  },
  "recovery.score.skin_temp_celsius": {
    type: "SKIN_TEMPERATURE",
    unit: "celsius",
  },
  "sleep.score.stage_summary.*_time_milli": {
    type: "SLEEP_DURATION",
    unit: "minutes",
    factor: MS_TO_MIN,
    note: "one row per stage (light→CORE, slow-wave→DEEP, rem→REM, awake→AWAKE, in-bed→IN_BED)",
  },
  "sleep.score.sleep_needed.*_milli": {
    type: "SLEEP_NEED",
    unit: "minutes",
    factor: MS_TO_MIN,
    note: "baseline + debt + strain + nap components summed",
  },
  "sleep.score.sleep_performance_percentage": {
    type: "SLEEP_PERFORMANCE",
    unit: "%",
  },
  "sleep.score.sleep_efficiency_percentage": {
    type: "SLEEP_EFFICIENCY",
    unit: "%",
  },
  "sleep.score.sleep_consistency_percentage": {
    type: "SLEEP_CONSISTENCY",
    unit: "%",
  },
  "sleep.score.respiratory_rate": {
    type: "RESPIRATORY_RATE",
    unit: "breaths/min",
  },
  "cycle.score.strain": { type: "DAY_STRAIN", unit: "score" },
  "cycle.score.kilojoule": { type: "ENERGY_EXPENDITURE_KJ", unit: "kJ" },
  "workout.score.strain": {
    type: "WORKOUT_STRAIN",
    unit: "score",
    note: "preferentially stored in Workout.metadata, not a free-floating Measurement",
  },
  "workout.score.kilojoule": {
    type: "Workout.totalEnergyKcal",
    unit: "kcal",
    factor: KJ_TO_KCAL,
    note: "kJ→kcal for the workout row",
  },
  "body.weight_kilogram": {
    type: "WEIGHT",
    unit: "kg",
    note: "picker ranks a real scale above WHOOP",
  },
  "body.max_heart_rate": {
    type: "WhoopConnection.maxHeartRate",
    unit: "bpm",
    note: "profile constant — stored on the connection, not a Measurement",
  },
  "body.height_meter": {
    type: "User.heightCm",
    unit: "cm",
    factor: M_TO_CM,
    note: "profile seed — written to User.heightCm only when it is null, never as a Measurement",
  },
};
