/**
 * The colour of each value line on the timeline (v1.42).
 *
 * A line takes the colour its measurement type already carries in the list
 * (`MEASUREMENT_TYPE_COLORS`, a `--chart-N` token), so weight reads in the
 * same colour on both pages. Where two chosen lines would share a colour
 * (systolic and diastolic, or resting pulse beside blood pressure) or a type
 * has none (mood), the later one takes the first `--chart-N` still free.
 * There are five data tokens and no cap on the lines: once all five are
 * taken, the next lines take them again in palette order. Every line is
 * named at its left, so a repeated colour never leaves a line unnamed. The
 * order of `rank` decides who keeps a contested colour, so the same set of
 * lines is coloured the same way whatever order it was picked in.
 */
import { MEASUREMENT_TYPE_COLORS } from "@/components/measurements/measurement-type-colors";

export const SERIES_PALETTE = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
] as const;

/** The type's own colour, as a `var(--chart-N)` string, or null. */
export function preferredSeriesColor(key: string): string | null {
  const match = /\btext-chart-([1-5])\b/.exec(
    MEASUREMENT_TYPE_COLORS[key] ?? "",
  );
  return match ? `var(--chart-${match[1]})` : null;
}

/**
 * One distinct colour per key. `rank` orders who keeps a contested colour
 * (keys missing from it come after, in their own order).
 */
export function assignSeriesColors(
  keys: readonly string[],
  rank: readonly string[] = [],
): Map<string, string> {
  const position = (key: string) => {
    const i = rank.indexOf(key);
    return i === -1 ? rank.length : i;
  };
  const ordered = [...new Set(keys)]
    .map((key, i) => ({ key, i }))
    .sort((a, b) => position(a.key) - position(b.key) || a.i - b.i)
    .map(({ key }) => key);

  const out = new Map<string, string>();
  const taken = new Set<string>();
  for (const key of ordered) {
    const own = preferredSeriesColor(key);
    if (own && !taken.has(own)) {
      out.set(key, own);
      taken.add(own);
    }
  }
  let repeat = 0;
  for (const key of ordered) {
    if (out.has(key)) continue;
    const free = SERIES_PALETTE.find((c) => !taken.has(c));
    const color = free ?? SERIES_PALETTE[repeat++ % SERIES_PALETTE.length];
    out.set(key, color);
    taken.add(color);
  }
  return out;
}
