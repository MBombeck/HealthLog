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
  "metric:BLOOD_KETONES",
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
  "metric:BASAL_ENERGY_BURNED",
  "metric:FLIGHTS_CLIMBED",
  "metric:WALKING_RUNNING_DISTANCE",
  "metric:VO2_MAX",
  "metric:BODY_TEMPERATURE",
  // v1.4.25 — Withings full coverage. Same posture as v1.4.23 — the
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
  // v1.4.25 — Apple Health server-prep. Same posture as v1.4.23 /
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
  // v1.10.0 — additive HealthKit signals (WX-A). Same posture: the LLM
  // can reference these in prose; the chart components ride the existing
  // sub-page scaffold.
  "metric:CARDIO_RECOVERY",
  "metric:WRIST_TEMPERATURE",
  "metric:FALL_COUNT",
  "metric:SIX_MINUTE_WALK_DISTANCE",
  "metric:STAIR_ASCENT_SPEED",
  "metric:STAIR_DESCENT_SPEED",
  "metric:BREATHING_DISTURBANCES",
  // v1.10.0 — computed scores (WX-C). Server-derived 0–100 wellness scores.
  // Unlike the categorical EVENT classes they ARE a continuous daily series,
  // so they carry a `metric:<TYPE>` token and render through the generic
  // chart renderer. Only RECOVERY_SCORE is computed in v1.10.0; the other
  // two tokens are reserved for the later engines.
  "metric:RECOVERY_SCORE",
  "metric:STRESS_SCORE",
  "metric:STRAIN_SCORE",
  // v1.11.0 — WHOOP-native score classes. Continuous daily series, so each
  // carries a `metric:<TYPE>` token and renders through the generic chart
  // renderer (unlike the categorical EVENT classes). Same posture as the
  // WX-C scores above: the LLM can reference them in prose.
  "metric:HRV_RMSSD",
  "metric:DAY_STRAIN",
  "metric:WORKOUT_STRAIN",
  "metric:SLEEP_PERFORMANCE",
  "metric:SLEEP_EFFICIENCY",
  "metric:SLEEP_CONSISTENCY",
  "metric:SLEEP_NEED",
  "metric:ENERGY_EXPENDITURE_KJ",
  // v1.12.8 — WHOOP cycle + sleep coverage completion. Continuous daily
  // series, so each carries a `metric:<TYPE>` token and renders through the
  // generic chart renderer.
  "metric:AVERAGE_HEART_RATE",
  "metric:MAX_HEART_RATE",
  "metric:SLEEP_DISTURBANCE_COUNT",
  // v1.17.1 — Polar-native recovery / strain components. Continuous daily
  // series, so each carries a `metric:<TYPE>` token and renders through the
  // generic chart renderer alongside the WHOOP-native score classes.
  "metric:ANS_CHARGE",
  "metric:CARDIO_LOAD",
  // v1.17.1 — Oura coverage completion. Both are continuous nightly series, so
  // each carries a `metric:<TYPE>` token and renders through the generic chart.
  "metric:SLEEP_SCORE",
  "metric:BODY_TEMPERATURE_DEVIATION",
  // v1.19.0 — Oura resilience. A continuous daily ordinal series (1–5), so it
  // carries a `metric:<TYPE>` token and renders through the generic chart.
  "metric:RESILIENCE",
  // v1.25.0 — clinical signals. Mental-health screener totals (PHQ-9 0–27,
  // GAD-7 0–21) and the physical clinical measures are continuous numeric
  // series, so each carries a `metric:<TYPE>` token and renders through the
  // generic chart.
  "metric:PHQ9_SCORE",
  "metric:GAD7_SCORE",
  // v1.27.9 — WHO-5 (0–100 percentage) + SCI (0–32) screening totals; same
  // continuous-series contract, higher = better.
  "metric:WHO5_SCORE",
  "metric:SCI_SCORE",
  // v1.44 — Apple Health activity rings, mindfulness, State of Mind and
  // AFib burden. Charted through the generic series renderer.
  "metric:EXERCISE_MINUTES",
  "metric:STAND_MINUTES",
  "metric:STAND_HOURS",
  "metric:MINDFUL_MINUTES",
  "metric:STATE_OF_MIND_VALENCE",
  "metric:AFIB_BURDEN",
  // v1.44 — room climate from the ingest token.
  "metric:INDOOR_CO2",
  "metric:INDOOR_TEMPERATURE",
  "metric:INDOOR_HUMIDITY",
  // Garmin scores and the bridged training figures.
  "metric:BODY_BATTERY",
  "metric:STRESS_LEVEL",
  "metric:TRAINING_READINESS",
  "metric:ACUTE_TRAINING_LOAD",
  "metric:GRIP_STRENGTH",
  "metric:PAIN_NRS",
  "metric:WAIST_CIRCUMFERENCE",
  "metric:WAIST_TO_HEIGHT",
] as const;

export type ChartToken = (typeof ALLOWED_CHART_TOKENS)[number];

const ALLOWED_SET = new Set<string>(ALLOWED_CHART_TOKENS);

// v1.4.19 — strip vs parse split. The strip-side character class
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

// v1.4.25 — capitalised-Metric form. The maintainer reported the leak
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

// v1.4.25 — orphan enum-identifier leaks. The model sometimes
// drops the bare MeasurementType enum name straight into prose
// ("Your BLOOD_PRESSURE_SYS is elevated"). This was harmless when
// the only enums were short capitalised words but leaks badly with
// the v1.4.23 Apple-Health additions because the resulting prose
// reads as a database field name. Match the full enum list as a
// fixed alternation so we never accidentally cleave a real word
// (e.g. "MOOD") out of legitimate prose unless the model wrote it
// as the raw enum in upper-snake form.
const EXTRA_ORPHAN_ENUMS = [
  "PULSE_BPM",
  "MOOD_SCORE",
  "MEDICATION_COMPLIANCE_PCT",
] as const;

/**
 * Single words shared with the user-facing metric label. "Your WEIGHT trend is
 * stable" is legitimate prose, so these stay out of the stripper. Every entry
 * is a single word by construction — an upper-snake name is never prose.
 */
const PROSE_SAFE_SINGLE_WORDS = new Set<string>([
  "WEIGHT",
  "PULSE",
  "MOOD",
  "RESILIENCE",
]);

/**
 * Bare enum names cleaved out of prose, DERIVED from `ALLOWED_CHART_TOKENS`
 * rather than hand-maintained.
 *
 * The list used to be a literal array and drifted every time the allowlist
 * grew: by v1.30 eighteen allowlisted metrics had no strip entry, so a model
 * writing "Your PHQ9_SCORE is elevated" leaked the raw enum straight into
 * rendered text — the exact class this list exists to catch. Deriving it makes
 * that drift impossible.
 */
const ORPHAN_ENUMS: readonly string[] = [
  ...ALLOWED_CHART_TOKENS.map((token) => token.replace(/^metric:/, "")).filter(
    (name) => !PROSE_SAFE_SINGLE_WORDS.has(name),
  ),
  ...EXTRA_ORPHAN_ENUMS,
]
  // Longest first so the alternation never matches a shorter enum that is a
  // prefix of a longer one.
  .sort((a, b) => b.length - a.length);

// `\b` boundaries keep ordinary English prose untouched — "weight"
// (lowercase) or "BMI" (no underscore) never match. The fixed list
// also means we never accidentally strip a single capitalised word
// like "MOOD" or "WEIGHT" that has legitimate use as an in-prose
// metric label in display copy. The maintainer's directive (2026-05-14) is to
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
 * v1.4.17: legacy cached payloads from before the strict insight
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
 * v1.4.17: same defensive contract as `parseChartTokens()` —
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
