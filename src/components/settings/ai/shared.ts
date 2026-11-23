/**
 * Shared types, constants, and pure helpers for the Settings → AI
 * provider components. Extracted from the former 2k-LOC
 * `ai-section.tsx` monolith; one provider form per file lives next to
 * this module under `src/components/settings/ai/`.
 */

import type { CoachBudget } from "@/lib/ai/coach/coach-budgets";
import type { ReasoningEffort } from "@/lib/ai/reasoning-effort";

export interface InsightsSettings {
  codexStatus: string;
  codexConnectedAt: string | null;
  hasAdminKey: boolean;
  /** True when the operator has set `CODEX_OAUTH_CLIENT_ID` on this
   *  instance. The UI hides the "Connect with ChatGPT" button when
   *  false to avoid the v1.4.2 dead-end where the click bounced the
   *  user to chatgpt.com without any OAuth flow. */
  codexOauthConfigured?: boolean;
  /** True when the operator has connected the shared central Codex. Drives
   *  whether the per-user "use the server's shared AI access" switch shows. */
  centralCodexAvailable?: boolean;
  /** The user's own opt-in to the operator's shared central Codex. */
  useCentralCodex?: boolean;
  privacyMode: string;
  lastInsightAt: string | null;
}

export interface UserAIProvider {
  provider: string | null;
  /** The selected provider's model (Local's own when Local is selected). */
  model: string | null;
  /** The Local provider's base URL, whichever provider is selected. */
  baseUrl: string | null;
  /**
   * #1417 — the Local provider's own model, whichever provider is selected.
   * Absent on a payload from a server older than the field.
   */
  localModel?: string | null;
  hasAnthropicKey: boolean;
  anthropicKeyPreview: string | null;
  hasLocalKey: boolean;
  hasOpenaiKey: boolean;
  openaiKeyPreview: string | null;
  // v1.33.1 (#470) — the OpenAI-compatible gateway's own configuration. Its
  // own fields, because its own columns: the OpenAI provider is pinned to
  // api.openai.com and shares nothing with a user-supplied host.
  compatBaseUrl: string | null;
  compatModel: string | null;
  hasCompatKey: boolean;
  // v1.22 (#89) — per-user response timeout, in seconds (null = default).
  responseTimeoutSeconds: number | null;
  // #1126 — reasoning setting of the Local and gateway entries (null =
  // Default). Absent on a payload from a server older than the field.
  localReasoningEffort?: ReasoningEffort | null;
  compatReasoningEffort?: ReasoningEffort | null;
  /** The Coach budget of the Local provider and of the gateway (null = the
   *  built-in limits). Absent on a payload from a server older than them. */
  localCoachBudget?: CoachBudget | null;
  compatCoachBudget?: CoachBudget | null;
}

/** #1126 — the `reasoning_effort` values; "Off" is `none`. */
export type { ReasoningEffort };

/**
 * v1.4.16 — provider tags exposed to the UI. Mirrors
 * `PROVIDER_CHAIN_TYPES` server-side; kept as a const-array here to
 * avoid pulling a server-only module into the client bundle.
 */
export const PROVIDER_TYPES = [
  "codex",
  "openai",
  "anthropic",
  "local",
  "openai-compatible",
  "admin-openai",
] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

export interface ChainEntry {
  providerType: ProviderType;
  enabled: boolean;
}

export interface ProviderChainData {
  activeProvider: ProviderType | null;
  cachedActiveProvider: ProviderType | null;
  configuredChain: {
    providerType: ProviderType;
    enabled: boolean;
    available: boolean;
  }[];
}

/**
 * The chain a user starts with and returns to on reset. `openai-compatible`
 * is deliberately absent: it resolves only against a base URL somebody
 * configured, so a default entry would be dead weight for everyone else.
 * Users add it from the chain editor once their gateway is saved.
 */
export const DEFAULT_CHAIN: readonly ChainEntry[] = [
  { providerType: "codex", enabled: true },
  { providerType: "openai", enabled: true },
  { providerType: "anthropic", enabled: true },
  { providerType: "local", enabled: true },
  { providerType: "admin-openai", enabled: true },
];

/**
 * OpenAI model presets — the wire-up keeps users out of the freetext
 * box for the common case. The `__custom__` sentinel surfaces a
 * freetext input so power users can target preview models or
 * fine-tunes. The gpt-6 entries are the current workhorse and its
 * lighter sibling; every preset is a family `openai-model-family.ts`
 * recognises, so the reasoning, token-field and vision gates fit it.
 */
export const OPENAI_MODEL_PRESETS = [
  "gpt-6.1-sol",
  "gpt-6-luna",
  "gpt-4o",
  "gpt-4o-mini",
  "gpt-4-turbo",
] as const;
export const ANTHROPIC_MODEL_PRESETS = [
  "claude-sonnet-4-6",
  "claude-opus-4-7",
  "claude-sonnet-5",
  "claude-opus-5",
  "claude-haiku-4-5",
  "claude-3-5-sonnet-latest",
] as const;
export const LOCAL_MODEL_PRESETS = [
  "llama3.1:8b",
  "llama3.1:70b",
  "mistral",
  "qwen2.5",
] as const;
export const CUSTOM_MODEL_SENTINEL = "__custom__";

/**
 * Map UI provider tag → the stored `aiProvider` enum, the provider picked
 * under Settings, AI. `codex` and
 * `admin-openai` aren't user-level provider columns (they're handled
 * by Codex OAuth + admin-key fallback), so they map to null and the
 * legacy column is left blank.
 */
export function uiToLegacyProviderEnum(p: ProviderType): string | null {
  switch (p) {
    case "openai":
      return "OPENAI";
    case "anthropic":
      return "ANTHROPIC";
    case "local":
      return "LOCAL";
    case "openai-compatible":
      return "OPENAI_COMPATIBLE";
    case "codex":
    case "admin-openai":
    default:
      return null;
  }
}

// Map the connection-test failure category (a stable, secret-free code from
// /api/ai/test) to a localised message. Falls back to the server's plain
// English `reason` for any unmapped / legacy code so a German operator never
// sees an untranslated sentence in the otherwise-localised Settings panel.
export function localiseTestReason(
  t: (key: string, params?: Record<string, string | number>) => string,
  reasonCode: string | undefined,
  reason: string | undefined,
  httpStatus?: number | null,
): string | undefined {
  switch (reasonCode) {
    case "credentials":
      return t("settings.ai.testReasonCredentials");
    case "rate_limited":
      return t("settings.ai.testReasonRateLimited");
    case "server_error":
      return t("settings.ai.testReasonServerError");
    // v1.28.28 (#470) — the endpoint answered with a 4xx: a request-shape /
    // model-name problem, not connectivity. Falls back to the server's plain
    // reason when the status did not arrive (legacy response shape).
    case "bad_request":
      return httpStatus != null
        ? t("settings.ai.testReasonBadRequest", { status: httpStatus })
        : reason;
    case "unreachable":
      return t("settings.ai.testReasonUnreachable");
    default:
      return reason;
  }
}

export function isProviderType(v: string | null): v is ProviderType {
  return v != null && (PROVIDER_TYPES as readonly string[]).includes(v);
}

/**
 * #1404 — the tasks a named chain can be attached to, in the order the
 * settings list shows them. Mirrors `AI_CAPABILITY_KEYS` server-side (a guard
 * test holds the two equal); kept here so the client bundle does not pull the
 * capability table.
 */
export const NAMED_CHAIN_CAPABILITIES = [
  "documentAi",
  "labsOcr",
  "supplementLabel",
  "medicationExtract",
  "coach",
  "aboutMeQuestions",
  "briefing",
  "periodNarrative",
  "statusText",
  "workoutInsights",
  "reactionLines",
] as const;

/** Every provider type a named chain may list. */
export type ChainProviderType = ProviderType | "admin-codex";

export interface NamedChainView {
  id: string;
  name: string;
  entries: ChainProviderType[];
}

/** `GET /api/insights/provider-chains`. */
export interface NamedChainsData {
  chains: NamedChainView[];
  defaultChainId: string | null;
  attachments: Partial<
    Record<(typeof NAMED_CHAIN_CAPABILITIES)[number], string>
  >;
  /** The fallback chain's enabled entries, in order: what Default means. */
  mainChain: ChainProviderType[];
  providers: {
    providerType: ChainProviderType;
    available: boolean;
    /** Whether input to it stays on this machine or leaves it. */
    egress: "local" | "external";
  }[];
}
