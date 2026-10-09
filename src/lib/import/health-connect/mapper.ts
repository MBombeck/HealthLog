/**
 * Health Connect records onto HealthLog rows: units, identities, sport
 * types, device classes and the per-category app ranking.
 *
 * Units as Health Connect stores them (the `*RecordInternal` classes in the
 * AOSP HealthFitness module): mass in grams, energy in small calories (the
 * app's own display divides by 1000), volume in litres, length in metres,
 * blood glucose in mmol/L, temperature in °C, percentages as 0–100, times as
 * epoch milliseconds in UTC with the zone offset in seconds beside them.
 *
 * Identities. Every record carries a 16-byte UUID that is fixed in the
 * database and, for apps that set a client record id, derived from it; it is
 * the re-import key, written as `hc:<8-4-4-4-12>`. Rows that come from one
 * record but are not the record itself extend it: a heart-rate sample is
 * `hc:<series uuid>:<epoch ms>`, a sleep stage `hc:<session uuid>:<stage
 * start ms>`. Day totals and hourly means use the `stats:` family every other
 * aggregate in the table uses, under source `HEALTH_CONNECT`, so they never
 * meet an Apple Health row of the same name.
 */
import type {
  GlucoseContext,
  MeasurementType,
} from "@/generated/prisma/client";
import { mmolToMgdl } from "@/lib/glucose";
import { dailyStatsExternalId } from "@/lib/measurements/apple-health-mapping";
import { hourlyStatsExternalId } from "@/lib/measurements/dense-intraday-retention";
import { getUnitForType } from "@/lib/validations/measurement";
import { dateOnlyKey } from "@/lib/tz/date-only";
import { isStableExternalId } from "@/lib/validations/external-id";
import type { NutrientCode } from "@/lib/nutrients/catalog";

/** Health Connect `HealthDataCategory` values the importer ranks apps by. */
export const HC_CATEGORY = {
  ACTIVITY: 1,
  BODY_MEASUREMENTS: 2,
  CYCLE_TRACKING: 3,
  NUTRITION: 4,
  SLEEP: 5,
  VITALS: 6,
} as const;

export type HcCategory = (typeof HC_CATEGORY)[keyof typeof HC_CATEGORY];

/**
 * `hc:<uuid>`, or `hc:<uuid>:<n>` for a row derived from one record. The
 * UUID is formatted from the record's 16-byte blob, so it cannot be one of
 * the shapes the stability floor refuses; the floor is applied anyway, so a
 * future caller that passes something else fails here instead of writing a
 * rotating identity.
 */
export function hcExternalId(uuid: string, suffix?: number): string {
  const id = suffix === undefined ? `hc:${uuid}` : `hc:${uuid}:${suffix}`;
  if (!isStableExternalId(uuid)) {
    throw new Error("Health Connect record id is not a stable identity");
  }
  return id;
}

/** The HealthKit identifier the `stats:` ids of a type are spelled with. */
const STATS_IDENTIFIER: Partial<Record<MeasurementType, string>> = {
  ACTIVITY_STEPS: "HKQuantityTypeIdentifierStepCount",
  ACTIVE_ENERGY_BURNED: "HKQuantityTypeIdentifierActiveEnergyBurned",
  WALKING_RUNNING_DISTANCE: "HKQuantityTypeIdentifierDistanceWalkingRunning",
  PULSE: "HKQuantityTypeIdentifierHeartRate",
};

/** `stats:<identifier>:<YYYY-MM-DD>` for a day total. */
export function hcDailyStatsExternalId(
  type: MeasurementType,
  dayKey: string,
): string {
  const identifier = STATS_IDENTIFIER[type];
  if (!identifier) throw new Error(`no stats identifier for ${type}`);
  return dailyStatsExternalId(identifier, dayKey);
}

/** `stats:<identifier>:<YYYY-MM-DD>T<HH>` for an hourly heart-rate mean. */
export function hcHourlyPulseExternalId(dayKey: string, hour: number): string {
  return hourlyStatsExternalId(STATS_IDENTIFIER.PULSE!, dayKey, hour);
}

/**
 * `YYYY-MM-DD` of a Health Connect `local_date`: the record's calendar day in
 * its own zone, as a count of days since the epoch. A date-only value, so it
 * is read as the label of UTC midnight.
 */
export function dayKeyFromEpochDay(epochDay: number): string {
  return dateOnlyKey(new Date(epochDay * 86_400_000));
}

/**
 * An instant reading table and the HealthLog type(s) one row becomes. The
 * value column is in the table's own unit; `toDb` converts it.
 */
export interface InstantSpec {
  table:
    | "weight_record_table"
    | "body_fat_record_table"
    | "lean_body_mass_record_table"
    | "blood_pressure_record_table"
    | "resting_heart_rate_record_table"
    | "heart_rate_variability_rmssd_record_table"
    | "oxygen_saturation_record_table"
    | "respiratory_rate_record_table"
    | "blood_glucose_record_table"
    | "body_temperature_record_table"
    | "vo2_max_record_table";
  category: HcCategory;
  /** Columns read besides the common ones. */
  columns: readonly string[];
  /** The rows one record becomes; empty when its values are unusable. */
  map(row: Record<string, unknown>): Array<{
    type: MeasurementType;
    value: number;
    glucoseContext?: GlucoseContext | null;
  }>;
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** One value column, scaled by `factor`. */
function single(
  type: MeasurementType,
  column: string,
  factor = 1,
): Pick<InstantSpec, "columns" | "map"> {
  return {
    columns: [column],
    map(row) {
      const v = num(row[column]);
      return v === null ? [] : [{ type, value: v * factor }];
    },
  };
}

/**
 * `relation_to_meal` (a TEXT column holding an int) onto the context HealthLog
 * records: fasting and after a meal have a counterpart, the rest do not.
 */
export function glucoseContextFromRelation(
  relation: number | null,
): GlucoseContext | null {
  if (relation === 2) return "FASTING";
  if (relation === 4) return "POSTPRANDIAL";
  return null;
}

function textInt(v: unknown): number | null {
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v.trim())) return Number(v.trim());
  return null;
}

export const INSTANT_SPECS: readonly InstantSpec[] = [
  {
    table: "weight_record_table",
    category: HC_CATEGORY.BODY_MEASUREMENTS,
    ...single("WEIGHT", "weight", 1 / 1000),
  },
  {
    table: "body_fat_record_table",
    category: HC_CATEGORY.BODY_MEASUREMENTS,
    ...single("BODY_FAT", "percentage"),
  },
  {
    table: "lean_body_mass_record_table",
    category: HC_CATEGORY.BODY_MEASUREMENTS,
    ...single("LEAN_BODY_MASS", "mass", 1 / 1000),
  },
  {
    table: "blood_pressure_record_table",
    category: HC_CATEGORY.VITALS,
    columns: ["systolic", "diastolic"],
    map(row) {
      const sys = num(row.systolic);
      const dia = num(row.diastolic);
      // A reading is the pair; half of one is not stored.
      if (sys === null || dia === null) return [];
      return [
        { type: "BLOOD_PRESSURE_SYS", value: sys },
        { type: "BLOOD_PRESSURE_DIA", value: dia },
      ];
    },
  },
  {
    table: "resting_heart_rate_record_table",
    category: HC_CATEGORY.VITALS,
    ...single("RESTING_HEART_RATE", "beats_per_minute"),
  },
  {
    table: "heart_rate_variability_rmssd_record_table",
    category: HC_CATEGORY.VITALS,
    ...single("HRV_RMSSD", "heart_rate_variability_millis"),
  },
  {
    table: "oxygen_saturation_record_table",
    category: HC_CATEGORY.VITALS,
    ...single("OXYGEN_SATURATION", "percentage"),
  },
  {
    table: "respiratory_rate_record_table",
    category: HC_CATEGORY.VITALS,
    ...single("RESPIRATORY_RATE", "rate"),
  },
  {
    table: "blood_glucose_record_table",
    category: HC_CATEGORY.VITALS,
    columns: ["level"],
    map(row) {
      const level = num(row.level);
      if (level === null) return [];
      return [
        {
          type: "BLOOD_GLUCOSE",
          // mmol/L to the canonical mg/dL, the same conversion every other
          // writer of a mmol/L reading uses.
          value: mmolToMgdl(level),
          glucoseContext: glucoseContextFromRelation(
            textInt(row.relation_to_meal),
          ),
        },
      ];
    },
  },
  {
    table: "body_temperature_record_table",
    category: HC_CATEGORY.VITALS,
    ...single("BODY_TEMPERATURE", "temperature"),
  },
  {
    table: "vo2_max_record_table",
    category: HC_CATEGORY.ACTIVITY,
    ...single("VO2_MAX", "vo2_milliliters_per_minute_kilogram"),
  },
];

/** Optional columns an instant spec reads when the table has them. */
export const INSTANT_OPTIONAL_COLUMNS: Readonly<
  Partial<Record<InstantSpec["table"], readonly string[]>>
> = {
  blood_glucose_record_table: ["relation_to_meal"],
};

/** An interval table summed per day. */
export interface DailySumSpec {
  table:
    | "steps_record_table"
    | "active_calories_burned_record_table"
    | "distance_record_table";
  column: string;
  type: MeasurementType;
  /** Multiplies the summed column into the type's database unit. */
  factor: number;
}

export const DAILY_SUM_SPECS: readonly DailySumSpec[] = [
  {
    table: "steps_record_table",
    column: "count",
    type: "ACTIVITY_STEPS",
    factor: 1,
  },
  {
    // Small calories to kcal.
    table: "active_calories_burned_record_table",
    column: "energy",
    type: "ACTIVE_ENERGY_BURNED",
    factor: 1 / 1000,
  },
  {
    table: "distance_record_table",
    column: "distance",
    type: "WALKING_RUNNING_DISTANCE",
    factor: 1,
  },
];

/**
 * Nutrition columns (grams) onto the nutrient catalog. Energy and the
 * macronutrients are left out: the catalog is supplements and water, never a
 * food diary.
 */
export const NUTRITION_COLUMNS: Readonly<
  Partial<Record<NutrientCode, { column: string; factor: number }>>
> = (() => {
  const mg = 1000;
  const ug = 1_000_000;
  const codes: Array<[NutrientCode, number]> = [
    ["vitamin_a", ug],
    ["thiamin", mg],
    ["riboflavin", mg],
    ["niacin", mg],
    ["pantothenic_acid", mg],
    ["vitamin_b6", mg],
    ["biotin", ug],
    ["folate", ug],
    ["vitamin_b12", ug],
    ["vitamin_c", mg],
    ["vitamin_d", ug],
    ["vitamin_e", mg],
    ["vitamin_k", ug],
    ["calcium", mg],
    ["iron", mg],
    ["magnesium", mg],
    ["phosphorus", mg],
    ["zinc", mg],
    ["copper", mg],
    ["manganese", mg],
    ["selenium", ug],
    ["chromium", ug],
    ["molybdenum", ug],
    ["iodine", ug],
    ["caffeine", mg],
  ];
  return Object.fromEntries(
    codes.map(([code, factor]) => [code, { column: code, factor }]),
  );
})();

/** Litres of `hydration_record_table.volume` to the catalog's millilitres. */
export const HYDRATION_ML_PER_LITRE = 1000;

/** The database unit of `type`. */
export function hcUnit(type: MeasurementType): string {
  return getUnitForType(type);
}

/**
 * Health Connect `Device.type` onto the device classes the source picker
 * knows (`watch | band | ring | phone | scale | other | unknown`).
 */
export function deviceClassFromHc(deviceType: number | null): string | null {
  switch (deviceType) {
    case null:
      return null;
    case 0:
      return "unknown";
    case 1:
      return "watch";
    case 2:
      return "phone";
    case 3:
      return "scale";
    case 4:
      return "ring";
    case 6:
      return "band";
    default:
      return "other";
  }
}

/**
 * `ExerciseSessionType` onto the canonical sport set. Types with no
 * counterpart land on `other`; the raw number is kept on the workout's
 * metadata (`healthConnectExerciseType`) so the mapping stays reversible.
 */
const EXERCISE_TYPE_MAP: Readonly<Record<number, string>> = {
  1: "badminton",
  3: "basketball",
  4: "cycling",
  5: "cycling",
  6: "crossTraining",
  8: "strength",
  10: "dance",
  11: "mixedCardio",
  16: "golf",
  17: "mindAndBody",
  20: "hiit",
  21: "hiking",
  27: "mindAndBody",
  31: "rowing",
  33: "running",
  34: "running",
  41: "soccer",
  44: "stairClimber",
  45: "strength",
  46: "mindAndBody",
  48: "swimming",
  49: "swimming",
  51: "tennis",
  53: "walking",
  55: "strength",
  57: "yoga",
  58: "other",
  59: "stairClimber",
  60: "elliptical",
  61: "rowing",
};

/** Resolve a Health Connect exercise type to a canonical sport label. */
export function mapHealthConnectSportType(exerciseType: unknown): string {
  if (typeof exerciseType !== "number" || !Number.isInteger(exerciseType)) {
    return "other";
  }
  return EXERCISE_TYPE_MAP[exerciseType] ?? "other";
}

/**
 * Health Connect's own app ranking, per data category: the user's order in
 * the Health Connect settings ("app priority"), stored as a comma-separated
 * list of application row ids. Lower is better; an app the list does not
 * name ranks after every app it does.
 */
export class AppRanking {
  private readonly byCategory = new Map<number, Map<number, number>>();

  constructor(rows: ReadonlyArray<{ category: unknown; order: unknown }>) {
    for (const row of rows) {
      const category = typeof row.category === "number" ? row.category : NaN;
      if (!Number.isInteger(category) || typeof row.order !== "string") {
        continue;
      }
      const ranks = new Map<number, number>();
      row.order
        .split(",")
        .map((part) => Number(part.trim()))
        .filter((id) => Number.isInteger(id))
        .forEach((id, index) => {
          if (!ranks.has(id)) ranks.set(id, index);
        });
      this.byCategory.set(category, ranks);
    }
  }

  /** The app's rank in `category`; unlisted apps share the last place. */
  rank(category: number, appId: number): number {
    return this.byCategory.get(category)?.get(appId) ?? 1_000_000;
  }

  /** Whether the category has an explicit order naming `appId`. */
  lists(category: number, appId: number): boolean {
    return this.byCategory.get(category)?.has(appId) ?? false;
  }

  /**
   * The better of two apps: the lower rank, then (both unlisted, or a tie)
   * the lower application row id, so the choice is deterministic.
   */
  better(category: number, a: number, b: number): number {
    const ra = this.rank(category, a);
    const rb = this.rank(category, b);
    if (ra !== rb) return ra < rb ? a : b;
    return Math.min(a, b);
  }

  /**
   * Pick one app's total for a day. An app the priority list names wins over
   * any it does not; among unlisted apps the largest total wins, the way the
   * Apple Health importer picks a day's source.
   */
  pickDaily<T extends { appId: number; total: number }>(
    category: number,
    candidates: readonly T[],
  ): T | null {
    let best: T | null = null;
    for (const c of candidates) {
      if (!best) {
        best = c;
        continue;
      }
      const listedC = this.lists(category, c.appId);
      const listedB = this.lists(category, best.appId);
      if (listedC !== listedB) {
        if (listedC) best = c;
        continue;
      }
      if (listedC) {
        if (this.rank(category, c.appId) < this.rank(category, best.appId)) {
          best = c;
        }
        continue;
      }
      if (
        c.total > best.total ||
        (c.total === best.total && c.appId < best.appId)
      ) {
        best = c;
      }
    }
    return best;
  }
}
