/**
 * #1126 — the per-entry reasoning setting of the Local and OpenAI-compatible
 * providers, and the binder that stamps it onto a resolved provider.
 *
 * A leaf on purpose: `types.ts` and the binder are reachable from workers that
 * must not reach the provider machinery (`data-arrival-provider-isolation`),
 * so nothing here imports `provider-chain.ts`. The stored entry is read from
 * the raw chain directly, first match wins, the same rule
 * `parseProviderChain` dedupes by.
 */
import type { AIProvider } from "./types";

/**
 * The `reasoning_effort` values a chain entry may carry. "Off" in the settings
 * is `none` on the wire. The absence of the key is "Default": nothing is sent
 * and the model decides, which is what every chain stored before the setting
 * existed keeps doing.
 */
export const REASONING_EFFORTS = ["none", "low", "medium", "high"] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/**
 * The entries that may carry a reasoning effort: the two whose wire is a
 * person-chosen `/chat/completions` endpoint serving a model of their choice.
 * OpenAI, Anthropic and Codex pin their own model families and parameters,
 * so the setting is refused for them rather than silently dropped.
 */
export const REASONING_PROVIDER_TYPES = ["local", "openai-compatible"] as const;

export type ReasoningProviderType = (typeof REASONING_PROVIDER_TYPES)[number];

export function isReasoningProviderType(
  providerType: string,
): providerType is ReasoningProviderType {
  return (REASONING_PROVIDER_TYPES as readonly string[]).includes(providerType);
}

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return (
    typeof value === "string" &&
    (REASONING_EFFORTS as readonly string[]).includes(value)
  );
}

/**
 * The reasoning effort stored on a provider type's entry in a persisted chain,
 * enabled or not. `null` is Default: no chain, no entry, no valid value, or a
 * type that cannot carry one.
 */
export function reasoningEffortFor(
  rawChain: unknown,
  providerType: string,
): ReasoningEffort | null {
  if (!isReasoningProviderType(providerType) || !Array.isArray(rawChain)) {
    return null;
  }
  const entry = rawChain.find(
    (item): item is { reasoningEffort?: unknown } =>
      item != null &&
      typeof item === "object" &&
      (item as { providerType?: unknown }).providerType === providerType,
  );
  return isReasoningEffort(entry?.reasoningEffort)
    ? entry.reasoningEffort
    : null;
}

/**
 * Stamp the record owner's reasoning effort onto a resolved provider. Keyed on
 * the instance's runtime type, so only a Local client or an OpenAI-compatible
 * gateway can ever carry one: the operator's provider, the personal OpenAI
 * key, Anthropic and Codex resolve to `null` whatever the stored chain says.
 * Called by every exported resolver in `provider.ts` next to
 * `bindResponseTimeout`, with the raw `User.aiProviderChain` value.
 */
export function bindReasoningEffort<P extends AIProvider>(
  provider: P,
  aiProviderChain: unknown,
): P {
  provider.reasoningEffort = reasoningEffortFor(aiProviderChain, provider.type);
  return provider;
}
