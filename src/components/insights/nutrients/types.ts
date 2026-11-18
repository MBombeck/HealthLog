/**
 * v1.29 — shared client-side DTOs for the `/insights/nutrients` cards.
 * Mirror the Zod response schemas in `src/lib/validations/nutrients.ts`
 * (`nutrientDailySeriesSchema` / `nutrientOverviewSchema`) — kept as
 * plain interfaces here so the client components stay decoupled from
 * the server-only Zod module graph.
 */

export interface ResolvedNutrientReferenceDto {
  /** The body that set the value; absent on an older server (read as EFSA). */
  authority?: "EFSA" | "IOM" | "NIH ODS";
  kind: "PRI" | "AI" | "safeLevel";
  direction: "target" | "upperGuidance";
  value: number;
  source: string;
}

export interface NutrientDailySeries {
  nutrient: string;
  unit: string;
  windowDays: number;
  days: Array<{
    day: string;
    amount: number;
    bySource?: NutrientAmountBySource;
    aboveUpperLimit?: boolean | null;
  }>;
  reference: ResolvedNutrientReferenceDto | null;
  /** The target the person set for this nutrient; absent on an older server. */
  personalTarget?: NutrientPersonalTargetDto | null;
  upperLimit?: NutrientUpperLimitDto | null;
}

/** A daily amount the person set: one to reach, or one to stay under. */
export interface NutrientPersonalTargetDto {
  value: number;
  direction: "target" | "limit";
}

/** An amount split by the sources that counted; any other is absent. */
export type NutrientAmountBySource = Partial<
  Record<
    "APPLE_HEALTH" | "HEALTH_CONNECT" | "EXTERNAL" | "MANUAL" | "SUPPLEMENT",
    number
  >
>;

/** v1.43 — the tolerable upper intake level the server judged against. */
export interface NutrientUpperLimitDto {
  value: number;
  unit: string;
  scope: "total" | "supplemental";
  /** The chemical form the level covers; `null` for the nutrient as such. */
  form?:
    "retinol" | "folic_acid" | "magnesium_salts" | "alpha_tocopherol" | null;
  source: string;
}

export interface NutrientOverviewRow {
  nutrient: string;
  unit: string;
  latestDay: string;
  latestAmount: number;
  daysWithData: number;
  /** v1.43 — absent on an older server. */
  latestBySource?: NutrientAmountBySource;
  upperLimit?: NutrientUpperLimitDto | null;
  latestAboveUpperLimit?: boolean | null;
}

/**
 * Non-null only when `nutrients` is empty AND the most recent
 * `nutrient.batch.ingest` audit row shows a call that landed nothing —
 * `topReason` is the most common of the closed skip-reason codes
 * (`unit_mismatch` | `value_out_of_range` | `day_invalid` |
 * `upsert_failed`) from that call.
 */
export interface NutrientLastIngestAttempt {
  at: string;
  topReason: string;
}

export interface NutrientIntakeOverview {
  windowDays: number;
  nutrients: NutrientOverviewRow[];
  lastAttempt: NutrientLastIngestAttempt | null;
}
