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

export function getBodyFatTargetRange(gender: string | null | undefined): {
  min: number;
  max: number;
} {
  if (gender === "MALE") return { min: 10, max: 20 };
  if (gender === "FEMALE") return { min: 18, max: 28 };
  return { min: 12, max: 25 };
}
