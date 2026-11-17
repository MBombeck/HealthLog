/**
 * Where a nutrient day row came from. A closed set enforced here rather than
 * by a database enum (`NutrientIntakeDay.source` is text and part of the key):
 *
 *   - `APPLE_HEALTH`: the day total HealthKit synced (`POST /api/nutrients/batch`
 *     from the native client);
 *   - `HEALTH_CONNECT`: the day total an Android Health Connect import wrote;
 *   - `EXTERNAL`: the day total a bridge posted with a `measurements:write`
 *     token (`POST /api/nutrients/batch`), typically a food tracker;
 *   - `MANUAL`: water entered by hand (`POST /api/nutrients/water`);
 *   - `SUPPLEMENT` (v1.43): the sum of the day's taken supplement doses, from
 *     each medication's composition. Derived and recomputed, never entered.
 */
export const NUTRIENT_SOURCE = {
  APPLE_HEALTH: "APPLE_HEALTH",
  HEALTH_CONNECT: "HEALTH_CONNECT",
  EXTERNAL: "EXTERNAL",
  MANUAL: "MANUAL",
  SUPPLEMENT: "SUPPLEMENT",
} as const;

export type NutrientSource =
  (typeof NUTRIENT_SOURCE)[keyof typeof NUTRIENT_SOURCE];

const SOURCES: ReadonlySet<string> = new Set(Object.values(NUTRIENT_SOURCE));

export function isNutrientSource(value: string): value is NutrientSource {
  return SOURCES.has(value);
}

/**
 * Sources that each report the WHOLE day's intake, usually the same meals
 * logged once and mirrored through several systems (a food tracker writes into
 * Apple Health and also posts to HealthLog). Adding them would count a meal
 * twice, so a day counts only the largest of them. Order is the tie-break: on
 * equal amounts the earlier source is the one that counts.
 */
export const DAY_TOTAL_SOURCES: ReadonlyArray<NutrientSource> = [
  NUTRIENT_SOURCE.EXTERNAL,
  NUTRIENT_SOURCE.APPLE_HEALTH,
  NUTRIENT_SOURCE.HEALTH_CONNECT,
];
