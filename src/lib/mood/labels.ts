/**
 * v1.4.27 B6 / BL-P6-11 — single source of truth for mood verbal labels.
 *
 * Previously `mood-list.tsx` and `charts/mood-chart.tsx` each carried
 * their own label set:
 *   - List used `mood.levelSuperGut` / `levelGut` / `levelOkay` /
 *     `levelSchlecht` / `levelLausig` (rendering "Amazing / Good /
 *     Okay / Bad / Terrible").
 *   - Chart used `charts.moodLabel1..5` (rendering "Awful / Bad /
 *     Okay / Good / Great").
 *
 * Two distinct copy sets for the same five mood states drifted twice
 * during v1.4.18 / v1.4.25 polishing passes. Pinning both call-sites
 * to the same key map keeps the chart axis and the list copy in
 * lockstep.
 */

export const MOOD_ENUM_VALUES = [
  "LAUSIG",
  "SCHLECHT",
  "OKAY",
  "GUT",
  "SUPER_GUT",
] as const;

export type MoodEnum = (typeof MOOD_ENUM_VALUES)[number];

/** Mood enum → numeric score (1..5). Mirrors `getScoreForMood()`. */
export const MOOD_SCORE_BY_ENUM: Record<MoodEnum, number> = {
  LAUSIG: 1,
  SCHLECHT: 2,
  OKAY: 3,
  GUT: 4,
  SUPER_GUT: 5,
};

/** Numeric score (1..5) → mood enum. Inverse of `MOOD_SCORE_BY_ENUM`. */
export const MOOD_ENUM_BY_SCORE: Record<number, MoodEnum> = {
  1: "LAUSIG",
  2: "SCHLECHT",
  3: "OKAY",
  4: "GUT",
  5: "SUPER_GUT",
};

/**
 * Mood enum → i18n key for the verbal label.
 *
 * Both `components/mood/mood-list.tsx` and
 * `components/charts/mood-chart.tsx` import from this map. Adding a
 * new mood state means updating the enum + key map here once. The
 * indexer is `string` rather than `MoodEnum` because list rows arrive
 * from the API typed as `string` — the validation layer already
 * checked the enum bound via Zod, and a missing key returns
 * `undefined` rather than ever rendering a wrong label.
 */
export const MOOD_LABEL_KEYS: Record<string, string> = {
  SUPER_GUT: "mood.levelSuperGut",
  GUT: "mood.levelGut",
  OKAY: "mood.levelOkay",
  SCHLECHT: "mood.levelSchlecht",
  LAUSIG: "mood.levelLausig",
};

/** Numeric score (1..5) → i18n key for the verbal label. */
export function moodLabelKeyForScore(score: number): string | undefined {
  const moodEnum = MOOD_ENUM_BY_SCORE[score];
  if (!moodEnum) return undefined;
  return MOOD_LABEL_KEYS[moodEnum];
}
