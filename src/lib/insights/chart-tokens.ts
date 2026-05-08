/**
 * Chart-include tokens for AI insight prose.
 *
 * The LLM can embed one of the literal strings below inside `summary` or
 * `findings[].label` to inline-render the matching chart underneath the
 * paragraph. Every token the model emits is matched against this allowlist
 * — anything else (typos, hallucinations, attempts to inject other strings)
 * is silently dropped before it ever reaches the renderer.
 *
 * Render path: prose → parseChartTokens(prose) → <HealthChart> per token.
 * The visible prose is run through stripChartTokens so the literal token
 * string never surfaces in the UI.
 */
// Allowlist deliberately limited to MeasurementType values that
// `<HealthChart>` already understands (the type param feeds into
// `/api/measurements?type=<TYPE>` which Zod-validates against
// `measurementTypeEnum`).
//
// `MOOD` and `COMPLIANCE` are NOT in the enum — they need their own chart
// components, so emitting them here would render an empty "no data" panel
// under the model's prose. Excluded until those dedicated charts ship.
export const ALLOWED_CHART_TOKENS = [
  "metric:WEIGHT",
  "metric:BLOOD_PRESSURE_SYS",
  "metric:BLOOD_PRESSURE_DIA",
  "metric:PULSE",
  "metric:BODY_FAT",
  "metric:SLEEP_DURATION",
  "metric:ACTIVITY_STEPS",
  "metric:BLOOD_GLUCOSE",
  "metric:TOTAL_BODY_WATER",
  "metric:BONE_MASS",
  "metric:OXYGEN_SATURATION",
] as const;

export type ChartToken = (typeof ALLOWED_CHART_TOKENS)[number];

const ALLOWED_SET = new Set<string>(ALLOWED_CHART_TOKENS);

// Greedy `[A-Z_]+` match. Uppercase letters and underscores only — anything
// else (apostrophes, spaces, lowercase, digits) terminates the token, so
// trailing junk like `metric:WEIGHT' onclick='alert(1)'` cleaves cleanly
// into the safe metric and an inert text remainder.
const TOKEN_REGEX = /metric:[A-Z_]+/g;

/**
 * Find every well-formed chart token in `text` and return only those that
 * are in the allowlist. Hallucinated tokens (e.g. `metric:NUKE`) are
 * silently dropped.
 */
export function parseChartTokens(text: string): ChartToken[] {
  const matches: string[] = text.match(TOKEN_REGEX) ?? [];
  return matches.filter((m): m is ChartToken => ALLOWED_SET.has(m));
}

/** Strip the chart tokens out of the visible insight text. */
export function stripChartTokens(text: string): string {
  return text
    .replace(TOKEN_REGEX, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Map a chart token to the metric param the HealthChart component uses. */
export function tokenToMetric(token: ChartToken): string {
  return token.slice("metric:".length);
}
