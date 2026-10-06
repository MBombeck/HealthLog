/**
 * v1.41 — the reasoning levels, the thinking budget behind each, and the
 * background jobs that may reason.
 *
 * One vocabulary for every layer: the person's Coach preference
 * (`coachPrefsJson.reasoning`), the operator's cap
 * (`app_settings.ai_reasoning_max_effort`), the resolved value a call carries
 * (`CompletionParams.reasoning.effort`) and the level `/api/auth/me` publishes.
 * Each provider client maps it onto its own wire; nothing outside a client
 * speaks a provider's dialect.
 *
 * A leaf on purpose, like `../reasoning-effort.ts`: `types.ts` imports it, and
 * `types.ts` is reachable from workers that must not reach the provider
 * machinery. No import from `provider-chain.ts`, and none from a client.
 *
 * Client-safe: no server import.
 */

/**
 * `off` is the person's choice, not a promise about the wire: where a provider
 * cannot switch reasoning off, the client sends its lowest setting instead and
 * the settings say "Minimal" rather than "Off" (`offIsReal` in
 * `support.ts`).
 */
export const REASONING_LEVELS = ["off", "low", "medium", "high"] as const;

export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

/** The level an account that never chose one gets. */
export const DEFAULT_REASONING_LEVEL: ReasoningLevel = "medium";

/** The values the operator's cap may take; switching off is the other field. */
export const REASONING_MAX_EFFORTS = ["low", "medium", "high"] as const;

export type ReasoningMaxEffort = (typeof REASONING_MAX_EFFORTS)[number];

/** The cap an instance that never set one has: no cap. */
export const DEFAULT_REASONING_MAX_EFFORT: ReasoningMaxEffort = "high";

export function isReasoningLevel(value: unknown): value is ReasoningLevel {
  return (
    typeof value === "string" &&
    (REASONING_LEVELS as readonly string[]).includes(value)
  );
}

/** `level`, lowered to `max` when it is above it. */
export function capReasoningLevel(
  level: ReasoningLevel,
  max: ReasoningMaxEffort,
): ReasoningLevel {
  return REASONING_LEVELS.indexOf(level) > REASONING_LEVELS.indexOf(max)
    ? max
    : level;
}

/**
 * Thinking tokens per level, for the providers that take a token budget
 * rather than a named effort (Anthropic's manual mode, gateways that accept
 * `max_tokens`). A round's output allowance is its answer budget plus this.
 */
export const REASONING_THINKING_BUDGET: Readonly<
  Record<Exclude<ReasoningLevel, "off">, number>
> = {
  low: 1_024,
  medium: 4_096,
  high: 12_000,
};

/**
 * The background jobs that may reason. Every other unattended surface (status
 * cards, batch notes, archetypes, workout and reaction lines, nudges, document
 * reading, OCR) never does, and the inventory test freezes this list.
 */
export const BACKGROUND_REASONING_JOBS = [
  "daily_briefing",
  "period_narrative_month",
  "period_narrative_week",
  "memory_summary",
  "memory_facts",
  "memory_plans",
] as const;

export type BackgroundReasoningJob = (typeof BACKGROUND_REASONING_JOBS)[number];

/**
 * The level each job asks for: `level` on the person's own plan, key or local
 * model, `operatorLevel` when the operator pays for the call. Still capped by
 * the operator's settings like every other call.
 */
export const BACKGROUND_REASONING_LEVEL: Readonly<
  Record<
    BackgroundReasoningJob,
    { level: ReasoningLevel; operatorLevel: ReasoningLevel }
  >
> = {
  daily_briefing: { level: "medium", operatorLevel: "low" },
  period_narrative_month: { level: "medium", operatorLevel: "low" },
  period_narrative_week: { level: "low", operatorLevel: "low" },
  memory_summary: { level: "low", operatorLevel: "low" },
  memory_facts: { level: "low", operatorLevel: "low" },
  memory_plans: { level: "medium", operatorLevel: "low" },
};

// ── Message keys ────────────────────────────────────────────────────────────

/**
 * One option label per level. `minimal` stands in for `off` where the active
 * provider cannot switch reasoning off.
 */
export const REASONING_LEVEL_LABEL_KEYS = {
  off: "insights.coach.reasoning.off",
  minimal: "insights.coach.reasoning.minimal",
  low: "insights.coach.reasoning.low",
  medium: "insights.coach.reasoning.medium",
  high: "insights.coach.reasoning.high",
} as const;

/** The Coach settings field around the options. */
export const REASONING_SETTING_KEYS = {
  label: "insights.coach.reasoning.label",
  hint: "insights.coach.reasoning.hint",
  capped: "insights.coach.reasoning.capped",
  disabled: "insights.coach.reasoning.disabled",
} as const;

/** The operator's two controls in the admin assistant section. */
export const REASONING_ADMIN_KEYS = {
  enabled: "admin.assistant.reasoning.enabled",
  max: "admin.assistant.reasoning.max",
  description: "admin.assistant.reasoning.description",
} as const;
