/**
 * v1.41 — how hard one call may think, decided once per Coach turn or job.
 *
 * ## The one entry point
 *
 *     resolveReasoning({ surface, userPref, admin, costOwner, support })
 *       → { effort, summaries, source }
 *
 *   - `surface`: `"coach"` or one of the background jobs in
 *     `BACKGROUND_REASONING_JOBS`. Nothing else is representable, which is
 *     the point: a status card, a batch note, an archetype, a nudge or a
 *     document read has no surface to resolve against, so it cannot ask for
 *     reasoning by accident.
 *   - `userPref`: the person's Coach preference (`coachReasoningLevel(prefs)`).
 *     Read for the Coach only; a job's level comes from
 *     `BACKGROUND_REASONING_LEVEL`, never from the Coach preference.
 *   - `admin`: the operator's two controls, `loadReasoningControls()` in
 *     `./controls.ts` (one memoised read of the settings row).
 *   - `costOwner`: who pays the call, `resolveCostOwner(chain)` from the Coach
 *     budget module. An operator-funded chain is held to `medium` at most.
 *   - `support`: what the chain's primary can do (`reasoningSupport(...)`), or
 *     `null` when the caller does not know the model; unknown is optimistic,
 *     because the clients learn a refusal per endpoint (`dialect-cache.ts`).
 *
 * The order is fixed and every arm wins over the ones after it: the
 * operator's switch, the provider's ability, the requested level, the
 * operator's cap, the cost cap. `source` names the arm that decided, so a
 * dashboard and the settings both say why a level is what it is.
 *
 * `completionReasoning(resolved, surface)` turns the answer into the
 * `CompletionParams.reasoning` a call carries, or `undefined` when the call
 * should go out exactly as it did before reasoning existed. Pass the answer
 * budget as `maxTokens`; each client adds the thinking budget itself.
 *
 * A leaf on purpose: no Prisma, no provider client, no `provider-chain.ts`
 * value import, so a worker, a route and a test can all call it. The loaders
 * live in `./controls.ts`.
 */
import type { ProviderChainType } from "../provider-chain";
import type { CompletionParams } from "../types";
import {
  BACKGROUND_REASONING_LEVEL,
  DEFAULT_REASONING_LEVEL,
  DEFAULT_REASONING_MAX_EFFORT,
  REASONING_LEVELS,
  REASONING_MAX_EFFORTS,
  capReasoningLevel,
  type BackgroundReasoningJob,
  type ReasoningLevel,
  type ReasoningMaxEffort,
} from "./levels";
import { reasoningSupport, type ReasoningSupport } from "./support";

/** Where a resolution is asked for: the Coach, or one admitted job. */
export type ReasoningSurface = "coach" | BackgroundReasoningJob;

/** The operator's two controls on the settings row (migration 0376). */
export interface ReasoningAdminControls {
  enabled: boolean;
  maxEffort: ReasoningMaxEffort;
}

/** The controls an instance that never touched them has. */
export const DEFAULT_REASONING_ADMIN_CONTROLS: ReasoningAdminControls =
  Object.freeze({
    enabled: true,
    maxEffort: DEFAULT_REASONING_MAX_EFFORT,
  });

/**
 * Why the level is what it is:
 *
 *   - `user`: the person's Coach preference, unchanged.
 *   - `job`: the job's own level from the background table, unchanged.
 *   - `admin_off`: the operator switched reasoning off for the instance.
 *   - `admin_cap`: lowered to the operator's highest level.
 *   - `cost_cap`: lowered because the operator pays for the call.
 *   - `unsupported`: the provider cannot reason at all.
 */
export const REASONING_SOURCES = [
  "user",
  "job",
  "admin_off",
  "admin_cap",
  "cost_cap",
  "unsupported",
] as const;

export type ReasoningSource = (typeof REASONING_SOURCES)[number];

export interface ResolvedReasoning {
  effort: ReasoningLevel;
  /** Ask the provider for readable summaries (the Coach's live trail only). */
  summaries: boolean;
  source: ReasoningSource;
}

export type ReasoningCostOwner = "operator" | "user";

export interface ResolveReasoningInput {
  surface: ReasoningSurface;
  userPref?: ReasoningLevel | null;
  admin: ReasoningAdminControls;
  costOwner: ReasoningCostOwner;
  support?: ReasoningSupport | null;
}

/**
 * The Coach reasoning block on `GET /api/auth/me`, resolved on the server
 * (`loadCoachReasoningState`) and read by the web settings and the native
 * client alike. Client-safe, which is why it lives here.
 */
export interface CoachReasoningState {
  /** The level a Coach turn runs at now, every cap applied. */
  level: ReasoningLevel;
  /** What the person picked (`coachPrefsJson.reasoning`), `medium` when never. */
  preference: ReasoningLevel;
  /** The highest level the settings may offer; `off` when the operator switched it off. */
  maxLevel: ReasoningLevel;
  /** False when the operator switched reasoning off or the provider cannot reason. */
  available: boolean;
  /** False when the provider cannot switch reasoning off (the lowest option reads "Minimal"). */
  offIsReal: boolean;
  /** Why `level` is what it is. */
  source: ReasoningSource;
}

/** The highest level an operator-funded call may take (plan 7.2). */
export const OPERATOR_FUNDED_REASONING_CAP: ReasoningMaxEffort = "medium";

/** Narrow an untrusted settings value onto the cap vocabulary. */
export function parseReasoningMaxEffort(value: unknown): ReasoningMaxEffort {
  return typeof value === "string" &&
    (REASONING_MAX_EFFORTS as readonly string[]).includes(value)
    ? (value as ReasoningMaxEffort)
    : DEFAULT_REASONING_MAX_EFFORT;
}

function lower(a: ReasoningLevel, b: ReasoningLevel): boolean {
  return REASONING_LEVELS.indexOf(a) < REASONING_LEVELS.indexOf(b);
}

export function resolveReasoning(
  input: ResolveReasoningInput,
): ResolvedReasoning {
  const coach = input.surface === "coach";
  if (!input.admin.enabled) {
    return { effort: "off", summaries: false, source: "admin_off" };
  }
  if (input.support && !input.support.effort) {
    return { effort: "off", summaries: false, source: "unsupported" };
  }

  let effort: ReasoningLevel;
  let source: ReasoningSource;
  if (input.surface === "coach") {
    effort = input.userPref ?? DEFAULT_REASONING_LEVEL;
    source = "user";
  } else {
    const levels = BACKGROUND_REASONING_LEVEL[input.surface];
    effort =
      input.costOwner === "operator" ? levels.operatorLevel : levels.level;
    source = "job";
  }

  const adminCapped = capReasoningLevel(effort, input.admin.maxEffort);
  if (lower(adminCapped, effort)) {
    effort = adminCapped;
    source = "admin_cap";
  }
  if (input.costOwner === "operator") {
    const costCapped = capReasoningLevel(effort, OPERATOR_FUNDED_REASONING_CAP);
    if (lower(costCapped, effort)) {
      effort = costCapped;
      source = "cost_cap";
    }
  }

  return {
    effort,
    summaries: coach && effort !== "off" && (input.support?.summaries ?? true),
    source,
  };
}

/**
 * The `CompletionParams.reasoning` one call carries for `resolved`.
 *
 * `undefined` means "send what the call sent before reasoning existed": the
 * provider cannot reason, or a background job resolved to `off` (the
 * operator's switch included), which a job expresses by not asking. The Coach
 * sends an explicit `off` when the person or the operator chose it, so a
 * provider that can switch reasoning off really does (`offIsReal`).
 */
export function completionReasoning(
  resolved: ResolvedReasoning,
  surface: ReasoningSurface,
): CompletionParams["reasoning"] {
  if (resolved.source === "unsupported") return undefined;
  if (resolved.effort === "off" && surface !== "coach") return undefined;
  return { effort: resolved.effort, summaries: resolved.summaries };
}

/**
 * The highest level the Coach may take for this person right now: what the
 * settings dropdown offers. `off` when the operator switched reasoning off.
 */
export function coachReasoningCeiling(
  admin: ReasoningAdminControls,
  costOwner: ReasoningCostOwner,
): ReasoningLevel {
  if (!admin.enabled) return "off";
  return costOwner === "operator"
    ? capReasoningLevel(admin.maxEffort, OPERATOR_FUNDED_REASONING_CAP)
    : admin.maxEffort;
}

/**
 * What a chain entry can do with reasoning, from the configuration columns a
 * presence read already holds (no client built, no key decrypted). The chain
 * tag decides the client: the Codex paths are the Codex client, the person's
 * OpenAI key and the operator's slot are the OpenAI client (or Anthropic,
 * when the operator's base URL is Anthropic's), and so on. Model names fall
 * back to the defaults the resolvers use.
 */
export function reasoningSupportForChainEntry(
  providerType: ProviderChainType,
  config: {
    model?: string | null;
    compatModel?: string | null;
    compatBaseUrl?: string | null;
    adminModel?: string | null;
    adminIsAnthropic?: boolean;
  },
): ReasoningSupport {
  switch (providerType) {
    case "codex":
    case "admin-codex":
      return reasoningSupport("codex", "");
    case "openai":
      return reasoningSupport("admin-key", config.model ?? "gpt-4o");
    case "anthropic":
      return reasoningSupport("anthropic", config.model ?? "claude-sonnet-4-6");
    case "local":
      return reasoningSupport("local", config.model ?? "");
    case "openai-compatible":
      return reasoningSupport(
        "openai-compatible",
        config.compatModel ?? config.model ?? "",
        config.compatBaseUrl ? { baseUrl: config.compatBaseUrl } : {},
      );
    case "admin-openai":
      return config.adminIsAnthropic
        ? reasoningSupport(
            "anthropic",
            config.adminModel ?? "claude-sonnet-4-6",
          )
        : reasoningSupport("admin-key", config.adminModel ?? "gpt-4o");
  }
}
