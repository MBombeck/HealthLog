/**
 * The colour of each value line on the timeline (v1.42).
 *
 * A line takes the colour its measurement type already carries in the list
 * (`MEASUREMENT_TYPE_COLORS`, a `--chart-N` token), so weight reads in the
 * same colour on both pages. Where two chosen lines would share a colour
 * (systolic and diastolic, or resting pulse beside blood pressure) or a type
 * has none (mood), the later one takes the first `--chart-N` still free.
 * There are five data tokens and up to six lines; a sixth line with nothing
 * free left is drawn in `--foreground`, which is still apart from the other
 * five. The order of `rank` decides who keeps a contested colour, so the
 * same set of lines is coloured the same way whatever order it was picked
 * in.
 */
import { MEASUREMENT_TYPE_COLORS } from "@/components/measurements/measurement-type-colors";

export const SERIES_PALETTE = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
] as const;

/** The colour once every data token is taken. */
export const SERIES_FALLBACK_COLOR = "var(--foreground)";

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
  for (const key of ordered) {
    if (out.has(key)) continue;
    const free = SERIES_PALETTE.find((c) => !taken.has(c));
    const color = free ?? SERIES_FALLBACK_COLOR;
    out.set(key, color);
    taken.add(color);
  }
  return out;
}
