/**
 * The three notable-day flags of the environment module (v1.42, #615): a
 * high pollen count, a hot night, and very poor air. The dashboard chips, the
 * Coach and MCP read's summary all count with these, so a day is "notable"
 * by one definition everywhere. Leaf module, safe on the client.
 *
 * Deliberately few and deliberately high: a flag is a quiet note about the
 * weather a day had, shown beside the person's own data, and a chip that is
 * on most summer days says nothing. None of them claims an effect on the
 * person: they describe the modelled outdoor air at a coarse location, which
 * is not anyone's personal exposure.
 *
 *  - Hot night: the day's minimum temperature at or above 20 °C, the
 *    meteorological "tropical night".
 *  - Very poor air: the European air-quality index reaching 80 at some hour
 *    of the day, the index's "very poor" band (60–80 is "poor", which a
 *    summer ozone afternoon reaches routinely).
 *  - High pollen: any kind at or above a coarse "high" mark, 100 grains/m³
 *    for the tree pollens (alder, birch, olive), 50 for grass, mugwort and
 *    ragweed. Approximate bands of the kind European pollen services use;
 *    individual sensitivity varies far more than these marks do.
 */

/** Minimum temperature (°C) at or above which a night counts as hot. */
export const HOT_NIGHT_MIN_C = 20;
/** European AQI at or above which the air counts as very poor. */
export const VERY_POOR_AIR_EAQI = 80;

/** The pollen kinds, in display order. */
export const POLLEN_KINDS = [
  "alder",
  "birch",
  "grass",
  "mugwort",
  "olive",
  "ragweed",
] as const;
export type PollenKind = (typeof POLLEN_KINDS)[number];

/** The grains/m³ at or above which each kind counts as high. */
export const POLLEN_HIGH_MARK: Readonly<Record<PollenKind, number>> = {
  alder: 100,
  birch: 100,
  olive: 100,
  grass: 50,
  mugwort: 50,
  ragweed: 50,
};

/** Pollen maxima of one day by kind; null = not covered. */
export type PollenByKind = Readonly<Record<PollenKind, number | null>>;

/** The day's highest pollen count over all kinds, or null when none covered. */
export function pollenMax(pollen: PollenByKind): number | null {
  let best: number | null = null;
  for (const kind of POLLEN_KINDS) {
    const value = pollen[kind];
    if (value != null && (best === null || value > best)) best = value;
  }
  return best;
}

/** The kinds at or above their high mark, in display order. */
export function highPollenKinds(pollen: PollenByKind): PollenKind[] {
  return POLLEN_KINDS.filter((kind) => {
    const value = pollen[kind];
    return value != null && value >= POLLEN_HIGH_MARK[kind];
  });
}

export function isHotNight(tempMin: number | null): boolean {
  return tempMin != null && tempMin >= HOT_NIGHT_MIN_C;
}

export function isVeryPoorAir(eaqiMax: number | null): boolean {
  return eaqiMax != null && eaqiMax >= VERY_POOR_AIR_EAQI;
}
