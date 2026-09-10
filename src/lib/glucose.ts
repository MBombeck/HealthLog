/**
 * Blood-glucose unit conversions.
 *
 * HealthLog stores glucose canonically in **mg/dL**. The UI can display in
 * mmol/L for users who prefer that (SI-unit countries). Conversion factor is
 * 18.0182 (per DGIM / DDG S3 guideline). We round to clinically meaningful
 * precision: 0 fractional digits for mg/dL, 1 for mmol/L.
 */

export type GlucoseUnit = "mg/dL" | "mmol/L";

/**
 * mg/dL per mmol/L, per the DGIM / DDG S3 guideline. Exported because it is
 * the one factor for this conversion in the tree: the inbound alias resolver
 * normalises a mmol/L cell with it, the glucose insight page scales its chart
 * by its reciprocal, and the helpers below round with it. Two nearly-equal
 * copies of a health conversion is how the same reading comes out as two
 * different numbers on two screens.
 */
export const MGDL_PER_MMOL = 18.0182;

export function mgdlToMmol(mgdl: number): number {
  return Math.round((mgdl / MGDL_PER_MMOL) * 10) / 10;
}

export function mmolToMgdl(mmol: number): number {
  return Math.round(mmol * MGDL_PER_MMOL);
}

export function convertGlucose(value: number, to: GlucoseUnit): number {
  return to === "mmol/L" ? mgdlToMmol(value) : Math.round(value);
}

/**
 * Convert a value the user typed in their display unit back to the
 * canonical mg/dL HealthLog stores. The inverse of {@link convertGlucose}
 * for the editor write path: a `5.5 mmol/L` target the user enters must
 * persist as `99 mg/dL`, not as the literal `5.5`. A `mg/dL` display unit
 * is already canonical, so it only rounds.
 */
export function toCanonicalMgdl(value: number, from: GlucoseUnit): number {
  return from === "mmol/L" ? mmolToMgdl(value) : Math.round(value);
}

export function resolveGlucoseUnit(
  userPreference: string | null | undefined,
): GlucoseUnit {
  return userPreference === "mmol/L" ? "mmol/L" : "mg/dL";
}

/**
 * The `GlucoseContext` enum members, in the order every surface iterates them.
 */
export const NAMED_GLUCOSE_CONTEXTS = [
  "FASTING",
  "POSTPRANDIAL",
  "RANDOM",
  "BEDTIME",
] as const;

export type NamedGlucoseContext = (typeof NAMED_GLUCOSE_CONTEXTS)[number];

/**
 * The bucket every reading lands in whose `glucoseContext` column is NULL,
 * blank, or not one of the four enum members.
 *
 * It is not a `GlucoseContext` value and never reaches the database — the
 * column stays NULL. It exists because a reading without a meal-time tag is
 * still a reading, and a surface that iterates only the named contexts drops
 * it silently. That is not hypothetical: a meter synced through Apple Health
 * writes no HealthKit meal-time metadata at all, so such an account has one
 * hundred percent of its readings here and saw an empty dashboard, empty
 * targets, and an empty doctor-report panel while the data was current
 * (#943). The Coach's glucose block already grouped them under the same
 * name — this promotes that one bucket to the shared notion the rest of the
 * tree resolves through.
 */
export const GLUCOSE_CONTEXT_UNSPECIFIED = "UNSPECIFIED";

export type GlucoseContextBucket =
  NamedGlucoseContext | typeof GLUCOSE_CONTEXT_UNSPECIFIED;

/** Canonical iteration order: the named contexts first, untagged last. */
export const GLUCOSE_CONTEXT_BUCKETS = [
  ...NAMED_GLUCOSE_CONTEXTS,
  GLUCOSE_CONTEXT_UNSPECIFIED,
] as const;

/**
 * Resolve a stored `glucose_context` cell to the bucket it belongs to.
 * NULL, an empty string, and any value outside the enum all resolve to
 * {@link GLUCOSE_CONTEXT_UNSPECIFIED} — the fail-open arm, because dropping
 * a reading is worse than filing it under "no meal-time tag".
 */
export function glucoseContextBucket(
  raw: string | null | undefined,
): GlucoseContextBucket {
  if (raw == null) return GLUCOSE_CONTEXT_UNSPECIFIED;
  const key = raw.trim().toUpperCase();
  return (NAMED_GLUCOSE_CONTEXTS as readonly string[]).includes(key)
    ? (key as NamedGlucoseContext)
    : GLUCOSE_CONTEXT_UNSPECIFIED;
}

/**
 * Group rows into their glucose buckets, in {@link GLUCOSE_CONTEXT_BUCKETS}
 * order, skipping buckets with no rows. Row order inside a bucket is the
 * caller's input order, so a caller that reads "latest" off the head or tail
 * keeps doing so.
 */
export function groupByGlucoseContext<T>(
  rows: readonly T[],
  contextOf: (row: T) => string | null | undefined,
): Array<[GlucoseContextBucket, T[]]> {
  const byBucket = new Map<GlucoseContextBucket, T[]>();
  for (const row of rows) {
    const bucket = glucoseContextBucket(contextOf(row));
    const list = byBucket.get(bucket);
    if (list) list.push(row);
    else byBucket.set(bucket, [row]);
  }
  return GLUCOSE_CONTEXT_BUCKETS.flatMap((bucket) => {
    const list = byBucket.get(bucket);
    return list ? [[bucket, list] as [GlucoseContextBucket, T[]]] : [];
  });
}

/**
 * Threshold metric key corresponding to a glucose bucket. Keeps the
 * effective-range resolver the single source of truth.
 *
 * The untagged bucket borrows the RANDOM band: a reading with no meal-time
 * tag IS a spot reading, which is exactly what RANDOM means, and inventing a
 * fifth threshold would give the user a second editor row that judges the
 * same readings by a different number.
 */
export function thresholdMetricForContext(
  context: GlucoseContextBucket,
):
  | "BLOOD_GLUCOSE_FASTING"
  | "BLOOD_GLUCOSE_POSTPRANDIAL"
  | "BLOOD_GLUCOSE_RANDOM"
  | "BLOOD_GLUCOSE_BEDTIME" {
  switch (context) {
    case "FASTING":
      return "BLOOD_GLUCOSE_FASTING";
    case "POSTPRANDIAL":
      return "BLOOD_GLUCOSE_POSTPRANDIAL";
    case "BEDTIME":
      return "BLOOD_GLUCOSE_BEDTIME";
    case "RANDOM":
    case GLUCOSE_CONTEXT_UNSPECIFIED:
      return "BLOOD_GLUCOSE_RANDOM";
  }
}
