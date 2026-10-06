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
 * v1.4.25 W5 — extended with `defaultWindow`, since then made the
 * Coach's lookback limit: a per-conversation window can narrow it, never
 * widen it (`src/lib/ai/coach/history-reach.ts`).
 */
import { z } from "zod/v4";

import {
  DEFAULT_REASONING_LEVEL,
  REASONING_LEVELS,
  type ReasoningLevel,
} from "@/lib/ai/reasoning/levels";

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
 * How far back the Coach may look. This is a LIMIT, enforced
 * by every Coach read (`src/lib/ai/coach/history-reach.ts`): the snapshot,
 * every retrieval tool, the availability probe and the fixed-window blocks.
 * Before, it only seeded the snapshot window and each tool's default, and a
 * tool could read further back on its own. Values mirror `CoachScopeWindow`
 * (`src/lib/ai/coach/types.ts`) so the chat route folds it into the scope
 * without a translation layer. `lastYear` came with the limit. The default
 * stays `allTime`, which is no limit, so a legacy row keeps its behaviour.
 */
export const coachDefaultWindowEnum = z
  .enum(["last7days", "last30days", "last90days", "lastYear", "allTime"])
  .describe(
    "How far back the Coach may read, in every answer: snapshot, retrieval tools and summaries alike. `allTime` (the default) is no limit. Formerly only the starting window; `lastYear` came with the limit.",
  );
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
 * v1.18.1 (Workstream C) — Coach cadence-suggestion state. Persisted
 * inside the same `coachPrefsJson` blob so the suggestion engine has a
 * single, atomic place for the non-naggy machinery:
 *
 *   - `enabled`: master opt-out for cadence suggestions (default ON; the
 *     toggle lives under Coach / Reminders settings).
 *   - `stopped`: the explicit "you measure enough — stop" path. Once the
 *     user picks it the Coach never suggests a cadence again until they
 *     re-enable. Distinct from `enabled:false` only in provenance (the user
 *     said "stop" from the card vs flipped the settings toggle); both
 *     suppress.
 *   - `dismissedCadences`: cadence ids the user dismissed. A dismissed
 *     cadence is never re-suggested (dismissal memory).
 *   - `lastSuggestedAt`: ISO instant of the last suggestion actually shown.
 *     Drives the cooldown (no second suggestion within the cooldown window).
 *
 * The shape is fully optional + defaulted so every legacy blob parses as
 * "suggestions on, nothing dismissed".
 */
export const coachReminderSuggestionPrefsSchema = z.object({
  enabled: z.boolean().default(true),
  stopped: z.boolean().default(false),
  dismissedCadences: z.array(z.string().max(64)).max(32).default([]),
  lastSuggestedAt: z.string().max(40).nullable().default(null),
});
export type CoachReminderSuggestionPrefs = z.infer<
  typeof coachReminderSuggestionPrefsSchema
>;

export const DEFAULT_REMINDER_SUGGESTION_PREFS: CoachReminderSuggestionPrefs = {
  enabled: true,
  stopped: false,
  dismissedCadences: [],
  lastSuggestedAt: null,
};

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
  // v1.18.1 (Workstream C) — cadence-suggestion state. Optional with NO
  // top-level default so a legacy blob (and `parse({})`) stays byte-
  // identical: an absent key reads as `undefined`, and call sites fall
  // back to `DEFAULT_REMINDER_SUGGESTION_PREFS`. When the key IS present,
  // its inner fields default (so `{}` fills to the all-on shape).
  reminderSuggestions: coachReminderSuggestionPrefsSchema.optional(),
  // v1.39.4 — up to three follow-up chips under the Coach's latest answer.
  // On by default: an absent key reads as on (`followUpChipsEnabled`), and
  // like `reminderSuggestions` it carries no schema default, so a legacy
  // blob and `parse({})` stay byte-identical. Only an explicit `false`
  // switches the chips off.
  followUpChips: z
    .boolean()
    .optional()
    .describe(
      "v1.39.4 — offer up to three follow-up chips under the Coach's latest answer. Absent means on; only `false` switches them off.",
    ),
  // v1.41 — how hard the Coach thinks before it answers. No schema default,
  // like the two keys above, so a legacy blob and `parse({})` stay
  // byte-identical; an absent key reads as `medium` (`coachReasoningLevel`).
  // The operator's switch and cap apply on top, server-side.
  reasoning: z
    .enum(REASONING_LEVELS)
    .optional()
    .describe(
      "v1.41 — how hard the Coach thinks before it answers: `off`, `low`, `medium` or `high`. Absent means `medium`. The operator may switch reasoning off or cap the level; the resolved value is published on `GET /api/auth/me` as `coachReasoning`.",
    ),
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

/** The person's reasoning level; an absent key is the default, `medium`. */
export function coachReasoningLevel(prefs: CoachPrefs): ReasoningLevel {
  return prefs.reasoning ?? DEFAULT_REASONING_LEVEL;
}

/**
 * Parse a row's `coachPrefsJson` Json blob into a typed `CoachPrefs`,
 * falling back to defaults when the row is null. Keeps the call sites at
 * `src/lib/ai/coach/snapshot.ts` and `src/lib/ai/coach/system-prompt.ts`
 * free of the null/parse plumbing.
 *
 * A drifted shape (a value a newer version wrote and this one reads after a
 * rollback, a hand-edit) is salvaged field by field: an invalid field falls
 * back to its own default and every valid one stays. Parsing the blob as a
 * whole used to drop everything on one bad field, metric exclusions
 * included, which turned an unknown lookback value into a privacy loss. The
 * two lists keep their known entries, so an unknown metric or cluster
 * narrows what the Coach reads rather than widening it.
 */
export function parseCoachPrefs(raw: unknown): CoachPrefs {
  if (raw == null) return DEFAULT_COACH_PREFS;
  const whole = coachPrefsSchema.safeParse(raw);
  if (whole.success) return whole.data;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return DEFAULT_COACH_PREFS;
  }
  const source = raw as Record<string, unknown>;
  const salvaged: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(coachPrefsSchema.shape)) {
    if (!(key in source)) continue;
    const value = knownItemsOnly(key, source[key]);
    if (field.safeParse(value).success) salvaged[key] = value;
  }
  if (Object.keys(salvaged).length === 0) return DEFAULT_COACH_PREFS;
  return coachPrefsSchema.parse(salvaged);
}

/** The entries of a list preference this version knows; other values as is. */
function knownItemsOnly(key: string, value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  const item =
    key === "excludeMetrics"
      ? coachExcludeMetricEnum
      : key === "dataClusters"
        ? coachDataClusterEnum
        : null;
  return item ? value.filter((entry) => item.safeParse(entry).success) : value;
}
