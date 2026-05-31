/**
 * v1.4.23 H4 — per-user Coach prompt-tuning preferences.
 *
 * Persisted as a Json blob on `User.coachPrefsJson`. Null = legacy
 * defaults (tone="warm", verbosity="default", no metrics excluded,
 * evidence disclosure closed by default). The Coach prompt builder +
 * snapshot builder both read this shape — the snapshot must filter on
 * `excludeMetrics` BEFORE landing in the system prompt so the model
 * never sees data the user opted out of.
 *
 * v1.4.25 W5 — extended with `defaultWindow`. The picker lives in the
 * settings sheet; the drawer header carries a per-conversation override
 * pill so a single chat can narrow the window without flipping the
 * global default. The chat route folds the saved preference into the
 * snapshot scope when the client didn't supply a window override.
 */
import { z } from "zod/v4";

/**
 * Tone presets the Coach system-prompt prefix toggles between. v1.4.22
 * landed `warm` as the default; `neutral` strips the warmth language
 * for users who prefer a clinical-adjacent style; `concise` caps
 * verbosity and skips the optional motivational-interviewing micro-
 * moves entirely.
 */
export const coachToneEnum = z.enum(["warm", "neutral", "concise"]);
export type CoachTone = z.infer<typeof coachToneEnum>;

/**
 * Verbosity presets. Maps onto the prompt's "60-180 words" guidance:
 * `brief` ≈ 30-90 words, `default` keeps the v1.4.22 range, `detailed`
 * lifts the cap to 250 words. The `concise` tone overrides verbosity
 * down to `brief` regardless of the verbosity selection — same
 * intuition as concise == short, the picker just keeps the controls
 * orthogonal in the UI for clarity.
 */
export const coachVerbosityEnum = z.enum(["brief", "default", "detailed"]);
export type CoachVerbosity = z.infer<typeof coachVerbosityEnum>;

/**
 * Metric scopes the user can exclude from every Coach turn. Matches
 * `CoachScopeSource` (`src/lib/ai/coach/types.ts`) so the snapshot
 * builder can filter without a translation step. Apple Health-only
 * metrics (hrv / sleep / resting_hr / steps) are listed alongside the
 * core five so iOS users have a single surface to manage their privacy
 * preferences.
 */
export const coachExcludeMetricEnum = z.enum([
  "bp",
  "weight",
  "pulse",
  "mood",
  "compliance",
  "hrv",
  "sleep",
  "resting_hr",
  "steps",
  // v1.4.36 W3 T2 — optional context blocks the user can opt out of.
  // `medications` covers the snapshot's compliance + GLP-1 weeklyContext;
  // `anthropometrics` covers height / age / gender on `context`. Each
  // gates a single labelled block at the snapshot/feature layer, so an
  // excluded block never lands in the prompt at all (not even as a
  // labelled-empty key).
  "medications",
  "anthropometrics",
]);
export type CoachExcludeMetric = z.infer<typeof coachExcludeMetricEnum>;

/**
 * v1.4.25 W5 — default analysis window the Coach uses when the client
 * doesn't supply a per-conversation override. Mirrors
 * `CoachScopeWindow` (`src/lib/ai/coach/types.ts`) so the chat route
 * can fold the preference into `scope.window` without a translation
 * layer. The default stays `allTime` to preserve the v1.4.24 behaviour
 * — every legacy row reads as "no opinion" until the user explicitly
 * picks a tighter default.
 */
export const coachDefaultWindowEnum = z.enum([
  "last7days",
  "last30days",
  "last90days",
  "allTime",
]);
export type CoachDefaultWindow = z.infer<typeof coachDefaultWindowEnum>;

/**
 * v1.7.0 — clustered, opt-in Coach data sources. Each cluster groups a
 * set of `CoachScopeSource` / `MeasurementType` / model reads behind a
 * single toggle in the Coach settings sheet. The snapshot builder
 * expands the enabled clusters into the source set when the request
 * does not carry an explicit `scope.sources` list, then subtracts
 * `excludeMetrics` as a post-filter (a cluster can be on while a single
 * metric inside it is excluded).
 *
 * The cluster set is the opt-in source of truth going forward;
 * `excludeMetrics` stays valid for back-compat and only narrows.
 */
export const coachDataClusterEnum = z.enum([
  "cardio",
  "body",
  "activity",
  "workouts",
  "sleep",
  "mood",
  "glucose",
  "medication",
  "mobility",
  "environment",
]);
export type CoachDataCluster = z.infer<typeof coachDataClusterEnum>;

/**
 * Clusters enabled when the user has never touched the cluster picker
 * (`dataClusters === undefined`). These four reproduce today's legacy
 * five domains: cardio carries BP + pulse, body carries weight, mood
 * and medication map straight through. The additive members riding
 * inside cardio/body (HRV, resting HR, body-composition) only surface
 * when the user actually has rows for them — empty blocks are dropped —
 * so a web-only account stays close to the legacy 5-domain output while
 * an iOS account quietly gains the extra signals it already stores.
 */
export const DEFAULT_COACH_CLUSTERS: ReadonlyArray<CoachDataCluster> = [
  "cardio",
  "body",
  "mood",
  "medication",
];

/**
 * Full preferences shape. Defaults are inlined into the schema so a
 * `safeParse({})` call returns the legacy v1.4.22 defaults — saves a
 * sprinkle of `?? defaultX` calls at the call sites.
 */
export const coachPrefsSchema = z.object({
  tone: coachToneEnum.default("warm"),
  verbosity: coachVerbosityEnum.default("default"),
  excludeMetrics: z.array(coachExcludeMetricEnum).max(11).default([]),
  showEvidenceByDefault: z.boolean().default(false),
  defaultWindow: coachDefaultWindowEnum.default("allTime"),
  // v1.7.0 — opt-in cluster selection. `undefined` (key absent) is the
  // back-compat sentinel: the snapshot builder expands
  // `DEFAULT_COACH_CLUSTERS` so a legacy user who never opened the
  // picker keeps the legacy domains. We deliberately do NOT `.default([])`
  // — an empty array means "the user turned everything off", which is a
  // distinct, valid state from "never picked".
  dataClusters: z.array(coachDataClusterEnum).max(10).optional(),
});

export type CoachPrefs = z.infer<typeof coachPrefsSchema>;

/**
 * Default preferences applied when the user has never opened the
 * settings cog. Equivalent to `coachPrefsSchema.parse({})` but
 * returned as a plain object so call sites can compare references
 * (e.g., short-circuit a snapshot rebuild when prefs match defaults).
 */
export const DEFAULT_COACH_PREFS: CoachPrefs = {
  tone: "warm",
  verbosity: "default",
  excludeMetrics: [],
  showEvidenceByDefault: false,
  defaultWindow: "allTime",
};

/**
 * Parse a row's `coachPrefsJson` Json blob into a typed `CoachPrefs`,
 * falling back to defaults when the row is null OR the persisted shape
 * has drifted (a forward-compat field rename, an admin-side hand-edit,
 * etc.). Keeps the call sites at `src/lib/ai/coach/snapshot.ts` and
 * `src/lib/ai/coach/system-prompt.ts` free of the null/parse plumbing.
 */
export function parseCoachPrefs(raw: unknown): CoachPrefs {
  if (raw == null) return DEFAULT_COACH_PREFS;
  const parsed = coachPrefsSchema.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT_COACH_PREFS;
}
