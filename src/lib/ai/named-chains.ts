/**
 * Named provider chains, attachable per AI capability (#1404).
 *
 * The record's main chain (`User.aiProviderChain`, see `./provider-chain.ts`)
 * stays what it always was: the order every capability reads by default, under
 * the capability's own rules (`AI_CAPABILITIES[key].providerOrder`). A record
 * may add named chains next to it (`User.aiNamedChains`), each an ordered list
 * of its provider entries, and attach a capability to one of them.
 *
 *   - An ATTACHED capability is pinned to its chain: exactly those entries, in
 *     exactly that order, and nothing else. No document reorder, no central
 *     Codex appended behind it, no gateway fallback, no last-working reorder.
 *     A one-entry chain is therefore a binding: if that provider cannot serve,
 *     the capability refuses instead of falling back to one nobody picked.
 *   - An UNATTACHED capability follows the default chain under today's rules.
 *     The default is the main chain unless a named chain is marked default, in
 *     which case that chain's entries take the main chain's place and every
 *     rule around them stays as it is.
 *
 * A chain entry is a provider type: a record holds one credential and one
 * model per provider, so the type names provider, key and model at once.
 * Reasoning effort stays on the main chain's entries (per provider, per
 * record), and the response timeout stays a record setting.
 *
 * Pure: no I/O, safe for the resolver, the routes and the guards alike.
 * Parsing is tolerant by design: anything malformed on disk is dropped rather
 * than breaking generation, and a dropped attachment falls back to the default
 * chain, never to a wider set of providers than the record configured.
 */
import {
  AI_CAPABILITY_KEYS,
  type AiCapabilityKey,
} from "@/lib/ai/capabilities/types";

import {
  parseProviderChain,
  PROVIDER_CHAIN_TYPES,
  type ProviderChainType,
} from "./provider-chain";
import type { ProviderChainResolved } from "./provider-runner";

/** At most this many named chains per record. */
export const MAX_NAMED_CHAINS = 10;
/** The longest chain name, in characters. */
export const MAX_CHAIN_NAME_LENGTH = 40;
/** A chain id: short, URL-safe, chosen by the client that created it. */
export const CHAIN_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

export interface NamedChain {
  id: string;
  name: string;
  /** Ordered, unique, at least one. */
  entries: ProviderChainType[];
}

export interface NamedChainsConfig {
  chains: NamedChain[];
  /** The named chain unattached capabilities follow; `null` = the main chain. */
  defaultChainId: string | null;
  /** Capability → chain id. A capability absent here follows the default. */
  attachments: Partial<Record<AiCapabilityKey, string>>;
}

function isProviderChainType(value: unknown): value is ProviderChainType {
  return (
    typeof value === "string" &&
    (PROVIDER_CHAIN_TYPES as readonly string[]).includes(value)
  );
}

function isCapabilityKey(value: string): value is AiCapabilityKey {
  return (AI_CAPABILITY_KEYS as readonly string[]).includes(value);
}

function parseChain(raw: unknown): NamedChain | null {
  if (raw == null || typeof raw !== "object") return null;
  const item = raw as { id?: unknown; name?: unknown; entries?: unknown };
  if (typeof item.id !== "string" || !CHAIN_ID_PATTERN.test(item.id)) {
    return null;
  }
  if (typeof item.name !== "string") return null;
  const name = item.name.trim().slice(0, MAX_CHAIN_NAME_LENGTH);
  if (name.length === 0) return null;
  if (!Array.isArray(item.entries)) return null;
  const entries: ProviderChainType[] = [];
  for (const entry of item.entries) {
    if (isProviderChainType(entry) && !entries.includes(entry)) {
      entries.push(entry);
    }
  }
  if (entries.length === 0) return null;
  return { id: item.id, name, entries };
}

/** Parse the stored value. Never throws; garbage reads as no named chains. */
export function parseNamedChains(raw: unknown): NamedChainsConfig {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return { chains: [], defaultChainId: null, attachments: {} };
  }
  const value = raw as {
    chains?: unknown;
    defaultChainId?: unknown;
    attachments?: unknown;
  };
  const chains: NamedChain[] = [];
  if (Array.isArray(value.chains)) {
    for (const item of value.chains) {
      if (chains.length >= MAX_NAMED_CHAINS) break;
      const chain = parseChain(item);
      if (chain && !chains.some((seen) => seen.id === chain.id)) {
        chains.push(chain);
      }
    }
  }
  const ids = new Set(chains.map((chain) => chain.id));
  const defaultChainId =
    typeof value.defaultChainId === "string" && ids.has(value.defaultChainId)
      ? value.defaultChainId
      : null;
  const attachments: Partial<Record<AiCapabilityKey, string>> = {};
  if (
    value.attachments != null &&
    typeof value.attachments === "object" &&
    !Array.isArray(value.attachments)
  ) {
    for (const [key, chainId] of Object.entries(value.attachments)) {
      if (!isCapabilityKey(key)) continue;
      if (typeof chainId !== "string" || !ids.has(chainId)) continue;
      attachments[key] = chainId;
    }
  }
  return { chains, defaultChainId, attachments };
}

/** The JSON the column stores, in canonical key order. */
export function serializeNamedChains(
  config: NamedChainsConfig,
): Record<string, unknown> {
  const attachments: Record<string, string> = {};
  for (const key of AI_CAPABILITY_KEYS) {
    const chainId = config.attachments[key];
    if (chainId) attachments[key] = chainId;
  }
  return {
    chains: config.chains.map((chain) => ({
      id: chain.id,
      name: chain.name,
      entries: [...chain.entries],
    })),
    defaultChainId: config.defaultChainId,
    attachments,
  };
}

/**
 * Which chain a capability reads.
 *
 *   - `main`: the main chain under today's rules (nothing configured, or the
 *     capability unattached while the main chain is the default).
 *   - `default`: unattached, and a named chain is marked default. Its entries
 *     take the main chain's place; the rules around them stay.
 *   - `pinned`: attached. Exactly these entries, in this order, nothing else.
 *
 * `null` asks for the default chain itself (the settings summary).
 */
export type ChainSelection =
  | { kind: "main" }
  | { kind: "default"; chainId: string; entries: readonly ProviderChainType[] }
  | { kind: "pinned"; chainId: string; entries: readonly ProviderChainType[] };

export function chainSelectionFor(
  config: NamedChainsConfig,
  capability: AiCapabilityKey | null,
): ChainSelection {
  const byId = (id: string | null | undefined) =>
    id ? config.chains.find((chain) => chain.id === id) : undefined;
  const attached = capability ? byId(config.attachments[capability]) : null;
  if (attached) {
    return { kind: "pinned", chainId: attached.id, entries: attached.entries };
  }
  const named = byId(config.defaultChainId);
  if (named) {
    return { kind: "default", chainId: named.id, entries: named.entries };
  }
  return { kind: "main" };
}

/**
 * The configuration after deleting one chain: every capability attached to it
 * returns to the default chain, and when it was the default, the main chain
 * becomes the default again.
 */
export function detachChain(
  config: NamedChainsConfig,
  chainId: string,
): NamedChainsConfig {
  const attachments: Partial<Record<AiCapabilityKey, string>> = {};
  for (const [key, id] of Object.entries(config.attachments)) {
    if (id !== chainId) attachments[key as AiCapabilityKey] = id;
  }
  return {
    chains: config.chains.filter((chain) => chain.id !== chainId),
    defaultChainId:
      config.defaultChainId === chainId ? null : config.defaultChainId,
    attachments,
  };
}

/** Whether a resolved chain is a capability's pinned named chain. */
export function isPinnedChain(
  providers: readonly Pick<ProviderChainResolved, "pinned">[],
): boolean {
  return providers.some((p) => p.pinned === true);
}

/**
 * The provider types the default chain lists, in order: the enabled entries
 * of the main chain, or the entries of the named chain marked default. The
 * central Codex is never listed here; for an unattached capability it is
 * appended behind the person's opt-in, exactly as before.
 */
export function defaultChainTypes(
  config: NamedChainsConfig,
  rawMainChain: unknown,
): ProviderChainType[] {
  const selection = chainSelectionFor(config, null);
  if (selection.kind === "default") {
    return selection.entries.filter((type) => type !== "admin-codex");
  }
  return parseProviderChain(rawMainChain)
    .filter((entry) => entry.enabled)
    .map((entry) => entry.providerType);
}

/**
 * Each attached capability's chain, filtered to the entries `present` admits
 * and mapped through `toEntry`, in the chain's order. Unattached capabilities
 * are absent.
 */
export function pinnedChains<T>(
  config: NamedChainsConfig,
  present: (providerType: ProviderChainType) => boolean,
  toEntry: (providerType: ProviderChainType) => T,
): Partial<Record<AiCapabilityKey, T[]>> {
  const out: Partial<Record<AiCapabilityKey, T[]>> = {};
  for (const key of AI_CAPABILITY_KEYS) {
    const selection = chainSelectionFor(config, key);
    if (selection.kind !== "pinned") continue;
    out[key] = selection.entries.filter(present).map(toEntry);
  }
  return out;
}
