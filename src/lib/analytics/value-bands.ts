export interface ValueBand {
  min: number;
  max: number;
  color: string;
  opacity?: number;
  strokeOpacity?: number;
}

export interface TrafficRange {
  greenMin: number;
  greenMax: number;
  orangeMin: number;
  orangeMax: number;
}

interface TrafficBandOptions {
  lowerBound?: number;
  upperBound?: number;
  orangeFactor?: number;
}

export function buildTrafficLightBands(
  min: number,
  max: number,
  options: TrafficBandOptions = {},
): ValueBand[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
    return [];
  }

  const span = max - min;
  const orangeFactor = options.orangeFactor ?? 0.3;
  const orangeWidth = span * orangeFactor;
  const orangeLow = min - orangeWidth;
  const orangeHigh = max + orangeWidth;

  const lowerBound =
    options.lowerBound ?? Math.max(0, orangeLow - Math.max(span, 1) * 2);
  const upperBound = options.upperBound ?? orangeHigh + Math.max(span, 1) * 2;

  const bands: ValueBand[] = [
    { min: lowerBound, max: orangeLow, color: "#ff5555", opacity: 0.16 },
    { min: orangeLow, max: min, color: "#ffb86c", opacity: 0.18 },
    { min, max, color: "#50fa7b", opacity: 0.2 },
    { min: max, max: orangeHigh, color: "#ffb86c", opacity: 0.18 },
    { min: orangeHigh, max: upperBound, color: "#ff5555", opacity: 0.16 },
  ];

  return bands.filter((band) => band.max > band.min);
}

export function buildTrafficRange(
  min: number,
  max: number,
  orangeFactor = 0.3,
): TrafficRange | null {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
    return null;
  }
  const span = max - min;
  const orangeWidth = span * orangeFactor;
  return {
    greenMin: min,
    greenMax: max,
    orangeMin: min - orangeWidth,
    orangeMax: max + orangeWidth,
  };
}

export function buildWeightRangeFromHeight(heightCm: number): TrafficRange {
  const heightM = heightCm / 100;
  const h2 = heightM * heightM;

  return {
    greenMin: 18.5 * h2,
    greenMax: 24.9 * h2,
    orangeMin: 17 * h2,
    orangeMax: 29.9 * h2,
  };
}

export function buildWeightBandsFromHeight(
  heightCm: number,
  options: { lowerBound?: number; upperBound?: number } = {},
): ValueBand[] {
  const range = buildWeightRangeFromHeight(heightCm);
  const lowerBound = options.lowerBound ?? 30;
  const upperBound = options.upperBound ?? 250;

  return [
    { min: lowerBound, max: range.orangeMin, color: "#ff5555", opacity: 0.16 },
    {
      min: range.orangeMin,
      max: range.greenMin,
      color: "#ffb86c",
      opacity: 0.18,
    },
    {
      min: range.greenMin,
      max: range.greenMax,
      color: "#50fa7b",
      opacity: 0.2,
    },
    {
      min: range.greenMax,
      max: range.orangeMax,
      color: "#ffb86c",
      opacity: 0.18,
    },
    { min: range.orangeMax, max: upperBound, color: "#ff5555", opacity: 0.16 },
  ].filter((band) => band.max > band.min);
}

/**
 * Body-fat target range — the "green" band shown on the dashboard /
 * targets page / chart value-bands.
 *
 * Source: ACE (American Council on Exercise) body-composition standards
 *   https://www.acefitness.org/resources/everyone/blog/112/what-are-the-guidelines-for-percentage-of-body-fat-loss/
 * Bands per ACE:
 *   - Essential: M 2-5 / F 10-13 (warning band, very low; below ACE
 *     "essential" is dangerous)
 *   - Athletes:  M 6-13 / F 14-20 (clinically lean)
 *   - Fitness:   M 14-17 / F 21-24 (target floor for the typical
 *     non-athlete)
 *   - Acceptable:M 18-24 / F 25-31 (target ceiling)
 *   - Obese:     M 25+   / F 32+   (warning)
 *
 * The "green" band combines Fitness + Acceptable so the typical user's
 * realistic healthy range is shown, not the athlete band. Three sites
 * had different numbers in v1.3.3 — this is now the single source of
 * truth (targets/route.ts and chart value-bands import this helper).
 *
 * Cross-checked against:
 *   - Heyward V & Wagner D, "Applied Body Composition Assessment" 2nd ed
 *     (the underlying source ACE references for its public table).
 *   - WHO Expert Consultation 2008 ("Waist circumference and waist-hip
 *     ratio") — does NOT publish percent-fat bands; included here only
 *     to flag that "WHO body-fat thresholds" is a recurring
 *     hallucination to avoid.
 */
export function getBodyFatTargetRange(gender: string | null | undefined): {
  min: number;
  max: number;
} {
  if (gender === "MALE") return { min: 14, max: 24 };
  if (gender === "FEMALE") return { min: 21, max: 31 };
  // Gender-neutral fallback: midpoint of male/female fitness+acceptable.
  return { min: 17, max: 27 };
}
