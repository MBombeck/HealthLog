/**
 * v1.4.16 phase B5b — multi-provider redundancy.
 *
 * The persisted shape on `User.aiProviderChain` is a JSON array of
 * entries describing **which** providers to try and **in what order**.
 * Credentials live in the dedicated encrypted columns
 * (`codex*Encrypted`, `aiOpenaiKeyEncrypted`, `aiAnthropicKeyEncrypted`,
 * `aiLocalKeyEncrypted`); the chain is pure metadata so AES-256-GCM key
 * rotation via `scripts/rotate-encryption-key.ts` keeps working
 * unchanged.
 *
 * Why a separate module rather than inlining the parser into
 * `provider.ts`: the chain feeds three call sites (the runner, the
 * Settings UI summary endpoint, and the integration test fixture),
 * and a defensive parser-with-default keeps each call site short. A
 * malformed chain on disk (manual SQL edit, half-applied migration)
 * MUST never break insight generation — it falls back to the
 * `PROVIDER_CHAIN_DEFAULT`.
 */

import {
  isReasoningEffort,
  isReasoningProviderType,
  type ReasoningEffort,
  type ReasoningProviderType,
} from "./reasoning-effort";

/**
 * Provider tags used in the chain. `admin-openai` is the legacy
 * `AppSettings.adminAiKeyEncrypted` fallback (so misconfigured users
 * still see insights via the operator's key); `admin-codex` is the
 * operator-shared central Codex (ChatGPT-subscription) connection a user
 * opts into via `useCentralCodex`; the rest map 1:1 onto the per-user
 * encrypted-credential columns.
 *
 * `admin-codex` is NOT part of `PROVIDER_CHAIN_DEFAULT` and is never
 * offered in the chain editor — it is appended to a user's resolved chain
 * at resolution time ONLY when they opted in AND the operator connected it
 * (see `resolveProviderChain`), so a persisted `admin-codex` entry never
 * resolves on its own.
 *
 * `openai-compatible` (v1.33.1, #470) is the user-configured gateway —
 * LiteLLM, OpenRouter, vLLM, or any other endpoint on the
 * `/v1/chat/completions` wire. It is offered in the chain editor but is NOT
 * part of `PROVIDER_CHAIN_DEFAULT`: it resolves only against the base URL the
 * user saved, so putting it in the default chain would put an entry there
 * that can never resolve for anyone who has not configured it. It reads its
 * own three columns and never the OpenAI ones — the OpenAI arm's pinned base
 * URL stays pinned.
 *
 * Distinct from `ProviderType` (in `types.ts`) because that enum tags
 * the **runtime** provider instance — which has no notion of "admin
 * OpenAI" vs "user OpenAI" at the wire level (both are
 * `OpenAIClient`). The chain operates at the **resolution** layer
 * where that distinction matters.
 */
export const PROVIDER_CHAIN_TYPES = [
  "codex",
  "openai",
  "anthropic",
  "local",
  "openai-compatible",
  "admin-openai",
  "admin-codex",
] as const;

export type ProviderChainType = (typeof PROVIDER_CHAIN_TYPES)[number];

export interface ProviderChainEntry {
  providerType: ProviderChainType;
  priority: number;
  enabled: boolean;
  /** Only ever set on a `REASONING_PROVIDER_TYPES` entry. Absent = Default. */
  reasoningEffort?: ReasoningEffort;
}

/**
 * Default chain when the user has not customised one. Order reflects
 * the cheapest-first preference users have voiced in v1.4.x feedback:
 *   1. codex — covered by ChatGPT Pro/Plus subscription (no per-token
 *      cost on top of what the user already pays).
 *   2. openai — user's own API key, billed per token.
 *   3. anthropic — user's own API key.
 *   4. local — self-hosted Ollama / LM Studio.
 *   5. admin-openai — operator's shared key, last-ditch so a user with
 *      no personal config still sees insights.
 *
 * `openai-compatible` is deliberately absent: it resolves only against a
 * base URL the user saved, so a default entry would be dead weight for
 * everyone who never configures one. Users add it in the chain editor.
 */
export const PROVIDER_CHAIN_DEFAULT: readonly ProviderChainEntry[] = [
  { providerType: "codex", priority: 1, enabled: true },
  { providerType: "openai", priority: 2, enabled: true },
  { providerType: "anthropic", priority: 3, enabled: true },
  { providerType: "local", priority: 4, enabled: true },
  { providerType: "admin-openai", priority: 5, enabled: true },
];

/**
 * Parse the persisted JSON value into a sorted, deduplicated chain.
 * Tolerant by design — anything malformed collapses to the default
 * rather than 500-ing the request.
 *
 * Sort is stable (Array.prototype.sort guarantee since ES2019) so
 * priority ties preserve insertion order, which matches the UI's
 * drag-handle convention (admin-OpenAI vs user-OpenAI tied = whichever
 * the user dropped first wins).
 */
export function parseProviderChain(
  raw: unknown,
): readonly ProviderChainEntry[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    return PROVIDER_CHAIN_DEFAULT;
  }

  const seen = new Set<ProviderChainType>();
  const valid: ProviderChainEntry[] = [];
  for (const item of raw) {
    if (item == null || typeof item !== "object") continue;
    const candidate = item as {
      providerType?: unknown;
      priority?: unknown;
      enabled?: unknown;
      reasoningEffort?: unknown;
    };
    const providerType = candidate.providerType;
    if (typeof providerType !== "string") continue;
    if (!PROVIDER_CHAIN_TYPES.includes(providerType as ProviderChainType)) {
      continue;
    }
    if (seen.has(providerType as ProviderChainType)) continue;
    seen.add(providerType as ProviderChainType);
    const priority =
      typeof candidate.priority === "number" &&
      Number.isFinite(candidate.priority)
        ? candidate.priority
        : valid.length + 1;
    const enabled =
      typeof candidate.enabled === "boolean" ? candidate.enabled : true;
    // A reasoning effort survives only on an entry that may carry one and
    // only with a known value; anything else reads as Default.
    const reasoningEffort =
      isReasoningProviderType(providerType) &&
      isReasoningEffort(candidate.reasoningEffort)
        ? candidate.reasoningEffort
        : undefined;
    valid.push({
      providerType: providerType as ProviderChainType,
      priority,
      enabled,
      ...(reasoningEffort ? { reasoningEffort } : {}),
    });
  }

  if (valid.length === 0) return PROVIDER_CHAIN_DEFAULT;

  return valid.sort((a, b) => a.priority - b.priority);
}

/**
 * Inverse of `parseProviderChain` — produces the JSON the database
 * column stores. Kept as a helper so the writers can't accidentally
 * persist a non-canonical key order.
 */
export function serializeProviderChain(
  chain: readonly ProviderChainEntry[],
): string {
  return JSON.stringify(
    chain.map((e) => ({
      providerType: e.providerType,
      priority: e.priority,
      enabled: e.enabled,
      ...(e.reasoningEffort ? { reasoningEffort: e.reasoningEffort } : {}),
    })),
  );
}

/**
 * The chain to persist after setting (or, with `null`, clearing) one entry's
 * reasoning effort from that provider's own settings form.
 *
 * The setting lives on the chain entry, so a chain that was never customised
 * is materialised from the default first. A provider that is not in the chain
 * at all gets a DISABLED entry to hold the value: the setting must reach the
 * provider when it is resolved as the selected one, and a disabled entry is
 * inert everywhere else (every reader filters on `enabled`). Clearing on an
 * absent entry writes nothing new.
 */
export function chainWithReasoningEffort(
  rawChain: unknown,
  providerType: ReasoningProviderType,
  effort: ReasoningEffort | null,
): ProviderChainEntry[] {
  const chain = parseProviderChain(rawChain).map((e) => ({ ...e }));
  const entry = chain.find((e) => e.providerType === providerType);
  if (entry) {
    if (effort) entry.reasoningEffort = effort;
    else delete entry.reasoningEffort;
  } else if (effort) {
    chain.push({
      providerType,
      priority: Math.max(0, ...chain.map((e) => e.priority)) + 1,
      enabled: false,
      reasoningEffort: effort,
    });
  }
  return chain;
}
