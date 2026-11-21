/**
 * v1.10.0 — age/sex reference-range tables (the F1 enabler).
 *
 * The generic assessment registry (`metric-status-registry.ts`) already
 * threads a coarse, demographic-flat `normalRange` per metric and already
 * passes `age` + `sex` into the prompt. This module SHARPENS that slot:
 * `lookupNormalRange(metricId, ageYears, sex)` returns an age/sex-adjusted
 * band when a cited standard supports one, falling back to `null` so the
 * caller keeps the existing flat anchor (additive, behind the existing
 * behaviour — never a regression).
 *
 * Strictly age + sex. NO ancestry / ethnicity / region-of-birth ranges —
 * that is medically contentious and a data category HealthLog does not
 * collect (the registry already states this stance).
 *
 * Cited standards (one per table):
 *   - VO₂max percentile norms — Cooper Institute / FRIEND registry:
 *     Kaminsky et al. 2015, "Reference Standards for Cardiorespiratory
 *     Fitness Measured With Cardiopulmonary Exercise Testing", Mayo Clinic
 *     Proceedings 90(11):1515–1523. (The 50th-percentile age×sex band.)
 *   - Resting heart rate by age — standard physiology / population
 *     reference (adult resting-HR narrows with the AHA 60–100 bpm anchor;
 *     children/adolescents run higher — Fleming et al. 2011, Lancet
 *     377(9770):1011–1018, normal-range HR centiles by age).
 *   - Respiratory rate by age — clinical reference (WHO/PALS adult vs
 *     paediatric ranges).
 *   - Six-minute-walk distance — a published REGRESSION (not a bracket
 *     table): Enright & Sherrill 1998, "Reference Equations for the
 *     Six-Minute Walk in Healthy Adults", Am J Respir Crit Care Med
 *     158(5):1384–1387; the test itself standardised by ATS 2002,
 *     "ATS Statement: Guidelines for the Six-Minute Walk Test",
 *     Am J Respir Crit Care Med 166(1):111–117. Surfaced as a
 *     percent-of-predicted re-frame, never a HealthLog-derived equation.
 *   - Grip strength by age × sex — Dodds et al. 2014, "Grip Strength
 *     across the Life Course: Normative Data from Twelve British Studies",
 *     PLOS ONE 9(12):e113637 (n≈49,964). The age×sex band low is the 10th
 *     centile, FLOORED at the EWGSOP2 "probable sarcopenia" cut-off
 *     (Cruz-Jentoft et al., Age Ageing 2019: men < 27 kg, women < 16 kg) so
 *     the clinical floor is never crossed; the band high is the 50th-centile
 *     (median) for the age×sex cell.
 *   - Waist circumference by age × sex — WHO increased-risk thresholds
 *     (WHO 2008/2011; men > 94 cm, women > 80 cm) as the adult floor, raised
 *     for older adults: the WHO cut-points derive from cohorts aged 20–74,
 *     and evidence in the elderly supports cut-points set at higher waist
 *     values (toward the WHO substantially-increased-risk line, men > 102 cm /
 *     women > 88 cm). No ethnicity adjustment — HealthLog does not collect
 *     ancestry.
 *
 * Client-safe — pure data + a pure lookup, no server imports.
 */
import type { MetricStatusMetricId } from "@/lib/insights/metric-status-registry";
import type { ProfileSex } from "@/lib/profile/sex";

/** Profile sex as a reference-table lookup key; `undefined` = unknown. */
export type NormSex = ProfileSex | undefined;

/** A reference band — same shape as `MetricNormalRange`. */
export interface NormRange {
  low: number;
  high: number;
}

/** One age-bracketed row, optionally sex-specific. */
interface NormRow {
  /** Inclusive lower age bound (years). */
  minAge: number;
  /** Inclusive upper age bound (years). */
  maxAge: number;
  /** Sex this row applies to; `null` = applies to either. */
  sex: "MALE" | "FEMALE" | null;
  range: NormRange;
  /**
   * Age-INDEPENDENT clinical cut-off band (the EWGSOP2 grip floor / the WHO
   * waist threshold). It is excluded from the age-interpolation set and used
   * only as the no-age fallback for a sex-specific table — so a profile with
   * a known sex but no date of birth still gets the sex cut-off rather than
   * the coarse sex-flat registry anchor. The age-stratified rows already bake
   * this floor into their bounds, so it never widens the band for a known age.
   */
  ageIndependent?: boolean;
}

/**
 * VO₂max 50th-percentile bands (mL/(kg·min)) by decade × sex — derived
 * from the FRIEND registry (Kaminsky et al. 2015). The band brackets the
 * "Good" placement for the age×sex cell; the assessment leans on the
 * user's own trend, this only sharpens the population anchor.
 */
const VO2_MAX_NORMS: NormRow[] = [
  { minAge: 20, maxAge: 29, sex: "MALE", range: { low: 42, high: 53 } },
  { minAge: 30, maxAge: 39, sex: "MALE", range: { low: 39, high: 49 } },
  { minAge: 40, maxAge: 49, sex: "MALE", range: { low: 35, high: 45 } },
  { minAge: 50, maxAge: 59, sex: "MALE", range: { low: 31, high: 41 } },
  { minAge: 60, maxAge: 120, sex: "MALE", range: { low: 27, high: 37 } },
  { minAge: 20, maxAge: 29, sex: "FEMALE", range: { low: 36, high: 46 } },
  { minAge: 30, maxAge: 39, sex: "FEMALE", range: { low: 33, high: 43 } },
  { minAge: 40, maxAge: 49, sex: "FEMALE", range: { low: 30, high: 39 } },
  { minAge: 50, maxAge: 59, sex: "FEMALE", range: { low: 26, high: 35 } },
  { minAge: 60, maxAge: 120, sex: "FEMALE", range: { low: 22, high: 31 } },
];

/**
 * Resting-HR normal bands by age (bpm). Sex-agnostic — the adult band is
 * the AHA 60–100 anchor; younger ages run higher (Fleming et al. 2011
 * normal-range centiles). Direction is `lower-better` within the band.
 */
const RESTING_HEART_RATE_NORMS: NormRow[] = [
  { minAge: 0, maxAge: 1, sex: null, range: { low: 100, high: 160 } },
  { minAge: 2, maxAge: 5, sex: null, range: { low: 80, high: 120 } },
  { minAge: 6, maxAge: 12, sex: null, range: { low: 70, high: 110 } },
  { minAge: 13, maxAge: 17, sex: null, range: { low: 60, high: 100 } },
  { minAge: 18, maxAge: 120, sex: null, range: { low: 50, high: 90 } },
];

/**
 * Respiratory-rate normal bands by age (breaths/min). Sex-agnostic —
 * clinical reference (WHO/PALS): adult 12–20, paediatric ranges run
 * higher.
 */
const RESPIRATORY_RATE_NORMS: NormRow[] = [
  { minAge: 0, maxAge: 1, sex: null, range: { low: 30, high: 60 } },
  { minAge: 2, maxAge: 5, sex: null, range: { low: 20, high: 30 } },
  { minAge: 6, maxAge: 12, sex: null, range: { low: 18, high: 25 } },
  { minAge: 13, maxAge: 17, sex: null, range: { low: 12, high: 20 } },
  { minAge: 18, maxAge: 120, sex: null, range: { low: 12, high: 18 } },
];

/**
 * Grip-strength bands (kg) by age × sex — Dodds et al. 2014 (PLOS ONE
 * 9(12):e113637). `direction` is `higher-better`, so the read flags a value
 * below the low bound. Per age×sex cell: low = the Dodds 10th centile floored
 * at the EWGSOP2 "probable sarcopenia" cut-off (men 27 kg, women 16 kg;
 * Cruz-Jentoft et al., Age Ageing 2019) so the clinical floor is never
 * crossed; high = the Dodds 50th-centile (median). Strength peaks in the 30s
 * and declines from midlife, so the bands step down with age — a 70-year-old
 * is no longer measured against a 30-year-old's typical grip. The trailing
 * `ageIndependent` row is the EWGSOP2 sex cut-off used when the profile has a
 * sex but no date of birth (preserves the pre-v1.25.1 no-age behaviour).
 */
const GRIP_STRENGTH_NORMS: NormRow[] = [
  { minAge: 20, maxAge: 29, sex: "MALE", range: { low: 30, high: 40 } },
  { minAge: 30, maxAge: 39, sex: "MALE", range: { low: 38, high: 51 } },
  { minAge: 40, maxAge: 49, sex: "MALE", range: { low: 38, high: 50 } },
  { minAge: 50, maxAge: 59, sex: "MALE", range: { low: 35, high: 48 } },
  { minAge: 60, maxAge: 69, sex: "MALE", range: { low: 33, high: 45 } },
  { minAge: 70, maxAge: 79, sex: "MALE", range: { low: 29, high: 39 } },
  { minAge: 80, maxAge: 120, sex: "MALE", range: { low: 27, high: 32 } },
  { minAge: 20, maxAge: 29, sex: "FEMALE", range: { low: 21, high: 28 } },
  { minAge: 30, maxAge: 39, sex: "FEMALE", range: { low: 24, high: 31 } },
  { minAge: 40, maxAge: 49, sex: "FEMALE", range: { low: 23, high: 31 } },
  { minAge: 50, maxAge: 59, sex: "FEMALE", range: { low: 21, high: 29 } },
  { minAge: 60, maxAge: 69, sex: "FEMALE", range: { low: 18, high: 27 } },
  { minAge: 70, maxAge: 79, sex: "FEMALE", range: { low: 16, high: 24 } },
  { minAge: 80, maxAge: 120, sex: "FEMALE", range: { low: 16, high: 19 } },
  // EWGSOP2 sex cut-off — no-age fallback only (not age-interpolated).
  {
    minAge: 18,
    maxAge: 120,
    sex: "MALE",
    range: { low: 27, high: 60 },
    ageIndependent: true,
  },
  {
    minAge: 18,
    maxAge: 120,
    sex: "FEMALE",
    range: { low: 16, high: 60 },
    ageIndependent: true,
  },
];

/**
 * Waist-circumference bands (cm) by age × sex — `direction` is `lower-better`,
 * so the normal band runs from 0 up to the sex cut-off (the `high`). The WHO
 * increased-risk threshold (WHO 2008/2011; NIH/NHLBI 1998: men > 94 cm,
 * women > 80 cm) is the adult floor and is held flat through midlife. The WHO
 * cut-points derive from cohorts aged 20–74; evidence in the elderly supports
 * higher cut-points, so the threshold rises with age toward the WHO
 * substantially-increased-risk line (men > 102 cm, women > 88 cm). The floor
 * is never lowered — the standard threshold is the minimum. The trailing
 * `ageIndependent` row is the standard WHO threshold used when the profile has
 * a sex but no date of birth. No ethnicity adjustment.
 */
const WAIST_CIRCUMFERENCE_NORMS: NormRow[] = [
  { minAge: 18, maxAge: 49, sex: "MALE", range: { low: 0, high: 94 } },
  { minAge: 50, maxAge: 64, sex: "MALE", range: { low: 0, high: 94 } },
  { minAge: 65, maxAge: 79, sex: "MALE", range: { low: 0, high: 98 } },
  { minAge: 80, maxAge: 120, sex: "MALE", range: { low: 0, high: 102 } },
  { minAge: 18, maxAge: 49, sex: "FEMALE", range: { low: 0, high: 80 } },
  { minAge: 50, maxAge: 64, sex: "FEMALE", range: { low: 0, high: 80 } },
  { minAge: 65, maxAge: 79, sex: "FEMALE", range: { low: 0, high: 84 } },
  { minAge: 80, maxAge: 120, sex: "FEMALE", range: { low: 0, high: 88 } },
  // Standard WHO threshold — no-age fallback only (not age-interpolated).
  {
    minAge: 18,
    maxAge: 120,
    sex: "MALE",
    range: { low: 0, high: 94 },
    ageIndependent: true,
  },
  {
    minAge: 18,
    maxAge: 120,
    sex: "FEMALE",
    range: { low: 0, high: 80 },
    ageIndependent: true,
  },
];

/**
 * The norm tables, keyed by the assessment-registry metric id. A metric
 * absent from this map has no age/sex sharpening — the caller keeps the
 * flat registry anchor. Append a table here to lift another metric.
 */
const NORM_TABLES: Partial<Record<MetricStatusMetricId, NormRow[]>> = {
  VO2_MAX: VO2_MAX_NORMS,
  RESTING_HEART_RATE: RESTING_HEART_RATE_NORMS,
  RESPIRATORY_RATE: RESPIRATORY_RATE_NORMS,
  // v1.25.1 — age × sex bands, with a sex-specific clinical cut-off as the
  // floor + the no-age fallback.
  GRIP_STRENGTH: GRIP_STRENGTH_NORMS,
  WAIST_CIRCUMFERENCE: WAIST_CIRCUMFERENCE_NORMS,
};

/** The age a bracket row is anchored at for interpolation — its centre. */
function bracketCentre(row: NormRow): number {
  return (row.minAge + row.maxAge) / 2;
}

/**
 * Resolve the candidate rows for a profile sex: the sex-specific rows when
 * an exact match exists, else the sex-agnostic rows, else none. Returns the
 * rows ordered by bracket centre so the caller can interpolate across them.
 * `null` (rather than an empty array) signals "no honest band for this sex"
 * — a sex-specific-only table with no profile sex.
 */
function resolveSexRows(rows: NormRow[], sex: NormSex): NormRow[] | null {
  const exact = sex ? rows.filter((row) => row.sex === sex) : [];
  if (exact.length > 0) {
    return [...exact].sort((a, b) => bracketCentre(a) - bracketCentre(b));
  }
  const agnostic = rows.filter((row) => row.sex === null);
  if (agnostic.length > 0) {
    return [...agnostic].sort((a, b) => bracketCentre(a) - bracketCentre(b));
  }
  return null;
}

/**
 * Resolve the age/sex-adjusted reference band for a metric, or `null`
 * when no sharper band applies (unsupported metric, or demographics
 * absent). On `null` the caller keeps the existing flat `normalRange`
 * anchor — the enabler is strictly additive.
 *
 * Sex matching: a sex-specific table prefers the rows matching the profile
 * sex; when the profile sex is absent it falls back to the sex-agnostic
 * rows; a sex-specific-only table with no profile sex yields no honest band.
 *
 * Clinical-floor fallback: a table may carry an `ageIndependent` cut-off row
 * per sex (the EWGSOP2 grip floor / the WHO waist threshold). It is excluded
 * from age interpolation and returned only when no usable age is present, so a
 * grip / waist read still classifies against the sex cut-off for a profile
 * with a known sex but no date of birth. A table with no such row (VO₂max, …)
 * returns `null` without an age, keeping the flat registry anchor.
 *
 * Age handling: the bracket tables are coarse (decade / paediatric bands),
 * so a fractional age that lands near a bracket edge would otherwise read a
 * hard step at the boundary (e.g. 39.9 → 30s band, 40.0 → 40s band). Instead
 * each band is anchored at its bracket CENTRE and a fractional age is linearly
 * interpolated between the two adjacent centres — the band moves smoothly with
 * age. Below the youngest centre / above the oldest centre the nearest band is
 * held flat (clamp, never extrapolate), so the interpolated band always lies
 * within the span of the two cited bracket bands and the standard's provenance
 * stays accurate.
 */
export function lookupNormalRange(
  metricId: MetricStatusMetricId,
  ageYears: number | null | undefined,
  sex: NormSex,
): NormRange | null {
  const table = NORM_TABLES[metricId];
  if (!table) return null;

  const rows = resolveSexRows(table, sex);
  if (!rows || rows.length === 0) return null;

  // Split the age-independent clinical cut-off (the EWGSOP2 grip floor / the
  // WHO waist threshold) from the age-stratified bands. The cut-off is never
  // interpolated — it is the no-age fallback for a sex-specific table.
  const ageRows = rows.filter((row) => !row.ageIndependent);
  const floorBand = rows.find((row) => row.ageIndependent)?.range ?? null;

  // No usable age. A sex-specific clinical cut-off still applies (grip / waist
  // are flagged against the sex threshold even with no date of birth); a
  // purely age-banded metric (VO₂max, …) has no honest placement, so the
  // caller keeps the flat registry anchor.
  if (ageYears == null || !Number.isFinite(ageYears) || ageYears < 0) {
    return floorBand ? { ...floorBand } : null;
  }

  // No age-stratified rows (a cut-off-only table) — return the cut-off band.
  if (ageRows.length === 0) return floorBand ? { ...floorBand } : null;

  // Single band — no neighbour to interpolate against.
  if (ageRows.length === 1) return { ...ageRows[0].range };

  // Clamp below the youngest centre / above the oldest centre: hold the
  // nearest cited band flat rather than extrapolate past the table.
  const first = ageRows[0];
  const last = ageRows[ageRows.length - 1];
  if (ageYears <= bracketCentre(first)) return { ...first.range };
  if (ageYears >= bracketCentre(last)) return { ...last.range };

  // Find the two adjacent brackets whose centres bracket the age, then blend
  // their ranges by the fractional position between the centres.
  for (let i = 0; i < ageRows.length - 1; i++) {
    const lo = ageRows[i];
    const hi = ageRows[i + 1];
    const loCentre = bracketCentre(lo);
    const hiCentre = bracketCentre(hi);
    if (ageYears >= loCentre && ageYears <= hiCentre) {
      const span = hiCentre - loCentre;
      const fraction = span > 0 ? (ageYears - loCentre) / span : 0;
      // Round to one decimal: the cited brackets are integer-valued and the
      // interpolated band reads tidily in the prompt + tile without losing the
      // smoothing across the boundary.
      const round1 = (n: number) => Math.round(n * 10) / 10;
      return {
        low: round1(lo.range.low + (hi.range.low - lo.range.low) * fraction),
        high: round1(
          lo.range.high + (hi.range.high - lo.range.high) * fraction,
        ),
      };
    }
  }

  // Defensive — the clamp + loop above cover every finite age in range.
  return { ...last.range };
}

/**
 * Enright & Sherrill 1998 predicted six-minute-walk distance (metres) for a
 * healthy adult. A published linear regression on age, height, weight, sex —
 * NOT a HealthLog-derived model:
 *   - Men:   6MWD = 7.57·height_cm − 5.02·age − 1.76·weight_kg − 309
 *   - Women: 6MWD = 2.11·height_cm − 2.29·weight_kg − 5.78·age + 667
 *
 * Returns `null` when the inputs the equation needs are absent, so the caller
 * surfaces the raw distance + trend without a fabricated placement (the
 * `fitness-age.ts` `band: null` discipline). Sex is required (the two
 * coefficient sets differ); height is required (the dominant term). Weight is
 * required for the published full equation — when it is missing we return
 * `null` rather than silently dropping the weight term, since the omission
 * would inflate the predicted distance.
 *
 * Pure. The equation is for adults; for ages below 18 the reference does not
 * apply and we return `null`. The Enright & Sherrill cohort was ages 40–80;
 * outside that range the linear equation extrapolates, so the caveat copy
 * flags the predicted value as an extrapolation for younger / older users.
 */
export function predictSixMinuteWalkDistance(
  ageYears: number | null | undefined,
  heightCm: number | null | undefined,
  weightKg: number | null | undefined,
  sex: NormSex,
): number | null {
  if (sex !== "MALE" && sex !== "FEMALE") return null;
  if (
    ageYears == null ||
    !Number.isFinite(ageYears) ||
    ageYears < 18 ||
    ageYears > 120
  ) {
    return null;
  }
  if (heightCm == null || !Number.isFinite(heightCm) || heightCm <= 0) {
    return null;
  }
  if (weightKg == null || !Number.isFinite(weightKg) || weightKg <= 0) {
    return null;
  }
  const predicted =
    sex === "MALE"
      ? 7.57 * heightCm - 5.02 * ageYears - 1.76 * weightKg - 309
      : 2.11 * heightCm - 2.29 * weightKg - 5.78 * ageYears + 667;
  // A non-positive prediction is physically meaningless — treat as no band.
  return predicted > 0 ? predicted : null;
}
