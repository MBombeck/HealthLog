/**
 * Chart-include tokens for AI insight prose.
 *
 * The LLM can embed one of the literal strings below inside `summary` or
 * `findings[].label` to inline-render the matching chart underneath the
 * paragraph. Every token the model emits is matched against this allowlist
 * — anything else (typos, hallucinations, attempts to inject other strings)
 * is silently dropped before it ever reaches the renderer.
 *
 * Render path: prose → parseChartTokens(prose) → matching chart component
 * per token. The visible prose is run through stripChartTokens so the
 * literal token string never surfaces in the UI.
 */
// v1.4.3: allowlist extended with `metric:MOOD` so the AI can illustrate
// findings about mood drift inline. <MoodChart> is self-fetching, so the
// renderer just mounts it.
//
// `metric:COMPLIANCE` was prepared but pulled before ship — the existing
// <ComplianceLineChart> takes pre-aggregated daily data via props and
// has no self-fetching wrapper, so wiring it inline would silently
// render an empty chart. Land it in v1.5 once a self-fetching wrapper
// exists.
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
  "metric:MOOD",
  // v1.4.23 — Apple Health additions. The tokens are accepted by the
  // allowlist so the LLM can reference them; the corresponding chart
  // components ship in v1.5 alongside the iOS app surface.
  "metric:HEART_RATE_VARIABILITY",
  "metric:RESTING_HEART_RATE",
  "metric:ACTIVE_ENERGY_BURNED",
  "metric:FLIGHTS_CLIMBED",
  "metric:WALKING_RUNNING_DISTANCE",
  "metric:VO2_MAX",
  "metric:BODY_TEMPERATURE",
  // v1.4.25 W5d — Withings full coverage. Same posture as v1.4.23 — the
  // LLM can reference these in prose; dedicated chart components land in
  // v1.5 when the Insights body-composition + cardiovascular sub-pages
  // are designed.
  "metric:FAT_FREE_MASS",
  "metric:FAT_MASS",
  "metric:MUSCLE_MASS",
  "metric:SKIN_TEMPERATURE",
  "metric:PULSE_WAVE_VELOCITY",
  "metric:VASCULAR_AGE",
  "metric:VISCERAL_FAT",
  // v1.4.25 W8d — Apple Health server-prep. Same posture as v1.4.23 /
  // W5d: the LLM can reference these in prose; the corresponding
  // dedicated chart components land alongside the iOS-app sync.
  "metric:AUDIO_EXPOSURE_ENV",
  "metric:AUDIO_EXPOSURE_HEADPHONE",
  "metric:TIME_IN_DAYLIGHT",
  // v1.4.30 — R-F T1.4 + T1.5 Tier-1 additions. Same posture: the
  // LLM can reference the tokens in prose; the chart components land
  // alongside the iOS-app sync.
  "metric:WALKING_STEADINESS",
  "metric:AUDIO_EXPOSURE_EVENT",
  // v1.5.5 — iOS-coord additions. Same posture: the LLM can
  // reference these in prose; the chart components ride the
  // existing card-shelf renderer.
  "metric:RESPIRATORY_RATE",
  "metric:BODY_MASS_INDEX",
  "metric:LEAN_BODY_MASS",
  "metric:WALKING_HEART_RATE_AVERAGE",
  "metric:WALKING_ASYMMETRY",
  "metric:WALKING_DOUBLE_SUPPORT",
  // v1.5.5 iOS-coord follow-up — raw-SI gait pair. Same posture:
  // the LLM can reference these in prose; the chart components
  // ride the existing card-shelf renderer.
  "metric:WALKING_STEP_LENGTH",
  "metric:WALKING_SPEED",
] as const;

export type ChartToken = (typeof ALLOWED_CHART_TOKENS)[number];

const ALLOWED_SET = new Set<string>(ALLOWED_CHART_TOKENS);

// v1.4.19 A3 — strip vs parse split. The strip-side character class
// is permissive (`[A-Za-z0-9_]+`) so model-emitted lowercase or
// snake_case tokens like `metric:blood_pressure_sweet_spot` (verbatim
// maintainer probe 2026-05-10) get cleaved out of prose instead of leaking to the
// DOM. The parse-side class stays uppercase-only so unrenderable /
// hallucinated tokens are dropped from the *render* path entirely;
// only the *strip* is permissive.
//
// Trailing junk like `metric:WEIGHT' onclick='alert(1)'` still
// cleaves cleanly: the apostrophe terminates either character class,
// and the surviving uppercase token is the only one filtered through
// the allowlist for rendering.
const STRIP_TOKEN_REGEX = /metric:[A-Za-z0-9_]+/g;
const PARSE_TOKEN_REGEX = /metric:[A-Z_]+/g;

// v1.4.25 W5b — capitalised-Metric form. Marc reported the leak
// pattern `Metric Pressure_Sys` on /insights 2026-05-14: the model
// emitted the metric reference as a two-word phrase ("Metric" + space
// + enum-cased identifier) instead of the canonical `metric:<TYPE>`
// colon form. The colon-form regex above never matched this so the
// raw enum surfaced in the rendered prose.
//
// Match the capitalised "Metric" prefix followed by a space and one
// of: an upper-snake-case enum (`BLOOD_PRESSURE_SYS`) or a
// PascalCase-with-underscore form (`Pressure_Sys`). The character
// class allows mixed-case + digits + underscores so v1.4.23
// Apple-Health additions (`HEART_RATE_VARIABILITY`,
// `WALKING_RUNNING_DISTANCE`, etc.) get cleaved cleanly too. Word
// boundary `\b` on both ends prevents accidental matches inside
// ordinary prose ("Metricated", "submetric_x").
const METRIC_WORD_REGEX = /\bMetric\s+[A-Za-z][A-Za-z0-9_]*\b/g;

// v1.4.25 W5b — orphan enum-identifier leaks. The model sometimes
// drops the bare MeasurementType enum name straight into prose
// ("Your BLOOD_PRESSURE_SYS is elevated"). This was harmless when
// the only enums were short capitalised words but leaks badly with
// the v1.4.23 Apple-Health additions because the resulting prose
// reads as a database field name. Match the full enum list as a
// fixed alternation so we never accidentally cleave a real word
// (e.g. "MOOD") out of legitimate prose unless the model wrote it
// as the raw enum in upper-snake form.
const ORPHAN_ENUMS = [
  "BLOOD_PRESSURE_SYS",
  "BLOOD_PRESSURE_DIA",
  "PULSE_BPM",
  "MOOD_SCORE",
  "MEDICATION_COMPLIANCE_PCT",
  // v1.4.23 Apple Health additions — see ALLOWED_CHART_TOKENS above.
  "HEART_RATE_VARIABILITY",
  "RESTING_HEART_RATE",
  "ACTIVE_ENERGY_BURNED",
  "FLIGHTS_CLIMBED",
  "WALKING_RUNNING_DISTANCE",
  "VO2_MAX",
  "BODY_TEMPERATURE",
  "SLEEP_DURATION",
  // v1.4.25 W5d Withings additions. Multi-word upper-snake enum names
  // never appear in legitimate user-facing prose, so stripping them
  // unconditionally is safe.
  "FAT_FREE_MASS",
  "FAT_MASS",
  "MUSCLE_MASS",
  "SKIN_TEMPERATURE",
  "PULSE_WAVE_VELOCITY",
  "VASCULAR_AGE",
  "VISCERAL_FAT",
  // v1.4.25 W8d Apple Health server-prep — multi-word upper-snake
  // names that should never surface verbatim in user-facing prose.
  "AUDIO_EXPOSURE_ENV",
  "AUDIO_EXPOSURE_HEADPHONE",
  "TIME_IN_DAYLIGHT",
  // v1.5.5 iOS-coord additions — same shape, same posture.
  "RESPIRATORY_RATE",
  "BODY_MASS_INDEX",
  "LEAN_BODY_MASS",
  "WALKING_HEART_RATE_AVERAGE",
  "WALKING_ASYMMETRY",
  "WALKING_DOUBLE_SUPPORT",
  // v1.5.5 iOS-coord follow-up — raw-SI gait pair, same shape.
  "WALKING_STEP_LENGTH",
  "WALKING_SPEED",
] as const;

// `\b` boundaries keep ordinary English prose untouched — "weight"
// (lowercase) or "BMI" (no underscore) never match. The fixed list
// also means we never accidentally strip a single capitalised word
// like "MOOD" or "WEIGHT" that has legitimate use as an in-prose
// metric label in display copy. Marc's directive (2026-05-14) is to
// strip ONLY upper-snake / suffixed enum identifiers, not the
// canonical user-facing labels.
const ORPHAN_ENUM_REGEX = new RegExp(
  `\\b(?:${ORPHAN_ENUMS.join("|")})\\b`,
  "g",
);

/**
 * Find every well-formed chart token in `text` and return only those that
 * are in the allowlist. Hallucinated tokens (e.g. `metric:NUKE`) are
 * silently dropped.
 *
 * v1.4.17 hotfix: legacy cached payloads from before the strict insight
 * schema landed can deliver `undefined` here when the consumer reads a
 * field that didn't exist in the v1.4.14 shape (e.g. `insight.summary`
 * on a `{changed, stable, drivers, ...}` blob). Rather than crashing
 * the entire `/insights` page on a `text.match` of undefined, treat
 * non-string input as empty — the legacy-payload CTA owns the user-
 * facing recovery path.
 */
export function parseChartTokens(
  text: string | null | undefined,
): ChartToken[] {
  if (typeof text !== "string") return [];
  const matches: string[] = text.match(PARSE_TOKEN_REGEX) ?? [];
  return matches.filter((m): m is ChartToken => ALLOWED_SET.has(m));
}

/**
 * Strip the chart tokens out of the visible insight text.
 *
 * v1.4.17 hotfix: same defensive contract as `parseChartTokens()` —
 * non-string input returns the empty string instead of crashing the
 * caller. The empty result keeps the surrounding JSX render path
 * (`<p>{stripChartTokens(insight.summary)}</p>`) alive so the legacy-
 * payload CTA above it gets a chance to surface to the user.
 */
export function stripChartTokens(text: string | null | undefined): string {
  if (typeof text !== "string") return "";
  return text
    .replace(STRIP_TOKEN_REGEX, "")
    .replace(METRIC_WORD_REGEX, "")
    .replace(ORPHAN_ENUM_REGEX, "")
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Map a chart token to the metric param the underlying chart component
 *  expects. For MeasurementType-backed tokens this is a real enum value
 *  (`WEIGHT`, `PULSE`, …); for `MOOD` and `COMPLIANCE` it's a synthetic
 *  identifier the renderer routes to a dedicated chart component. */
export function tokenToMetric(token: ChartToken): string {
  return token.slice("metric:".length);
}

