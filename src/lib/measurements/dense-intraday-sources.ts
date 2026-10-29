/**
 * What the dense hourly fold (`dense-intraday-retention.ts`) takes: the
 * dense-tier types, and for each source the types it stores one row per
 * intraday sample of. The `folded_window` ingest guard (`folded-window.ts`)
 * reads the same map, so a source's raw samples are refused at ingest for
 * exactly the hours the fold has taken from it.
 */
import type {
  MeasurementSource,
  MeasurementType,
} from "@/generated/prisma/client";

/**
 * The dense-tier types. These are the high-frequency intra-day signals that
 * accumulate raw per-sample rows the destructive daily-mean drain never
 * touches:
 *
 *   - `HEART_RATE_VARIABILITY` + `PULSE` — the daytime shape the Stress
 *     engine reads.
 *   - `OXYGEN_SATURATION` — Apple Watch's Blood-Oxygen app samples SpO2
 *     periodically through the day and overnight; the readings map to
 *     `aggregation: "latest"` and sit in NEITHER `CUMULATIVE_HK_TYPES` nor
 *     `HIGH_FREQUENCY_MEAN_TYPES`, so every sample piled up raw forever.
 *     Folded here to hourly-mean rows with the daily min/max preserved on
 *     the rollup tier (the lowest sample is the overnight-desaturation
 *     nadir — clinically the meaningful figure, not the mean).
 *
 * Every member is deliberately EXEMPT from the destructive daily-mean drain
 * (`HIGH_FREQUENCY_MEAN_TYPES`); the disjointness from that set is the
 * load-bearing invariant a regression test pins — a type in both would be
 * folded by two drains at once and corrupt the value.
 *
 * `RESPIRATORY_RATE` is deliberately NOT here: it is already a member of
 * `HIGH_FREQUENCY_MEAN_TYPES`, so the nightly mean-consolidation already
 * collapses it to a daily-mean row. Adding it here would double-fold it.
 *
 * One fold grain per tier: every member folds HOURLY. A per-type grain
 * split would fork the write path and the rebuild for no reader benefit.
 */
export const DENSE_INTRADAY_RETENTION_TYPES: ReadonlySet<MeasurementType> =
  new Set<MeasurementType>([
    "HEART_RATE_VARIABILITY",
    "PULSE",
    "OXYGEN_SATURATION",
  ]);

/**
 * The sources whose raw dense samples fold, and which dense types of each.
 * A source belongs here only for a type it stores sample by sample through
 * the day; a type it stores as one value a day (a nightly SpO2 average, a
 * recovery's HRV) is no intraday stream, and folding that row would only
 * move it to another hour.
 *
 *   - Apple Health and Health Connect: every dense type. Both write the
 *     samples of an export raw, and without the fold every new export would
 *     add another quarter of minute-by-minute heart rate.
 *   - Google Health: heart rate, one row per sample from the `heart-rate`
 *     collection (SpO2 comes from the daily collection). A full-history
 *     backfill brought tens of millions of these onto one account (#1297).
 *   - Oura: heart rate, a reading every few minutes from the `heartrate`
 *     collection (SpO2 is the nightly average).
 *
 * Fitbit does not sync intraday heart rate, and WHOOP, Withings and Polar
 * write dense types only as one value per recovery, night or spot check, so
 * none of them is here.
 *
 * Each source folds into its OWN `stats:` rows, so an hour two sources both
 * covered keeps one mean per source, the same way the raw samples kept their
 * source. The walk runs in this order.
 */
export const DENSE_INTRADAY_FOLD_TYPES_BY_SOURCE = {
  APPLE_HEALTH: DENSE_INTRADAY_RETENTION_TYPES,
  HEALTH_CONNECT: DENSE_INTRADAY_RETENTION_TYPES,
  GOOGLE_HEALTH: new Set<MeasurementType>(["PULSE"]),
  OURA: new Set<MeasurementType>(["PULSE"]),
} as const satisfies Partial<
  Record<MeasurementSource, ReadonlySet<MeasurementType>>
>;

export type DenseIntradayFoldSource =
  keyof typeof DENSE_INTRADAY_FOLD_TYPES_BY_SOURCE;

/** Every source the fold walks, in walk order. */
export const DENSE_INTRADAY_FOLD_SOURCES = Object.keys(
  DENSE_INTRADAY_FOLD_TYPES_BY_SOURCE,
) as readonly DenseIntradayFoldSource[];
