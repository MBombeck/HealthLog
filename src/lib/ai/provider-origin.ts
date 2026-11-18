/**
 * Origin and gateway fallback helpers for AI provider chain resolution.
 */
import { parseProviderChain } from "./provider-chain";

/**
 * Origin of the provider that would serve a given user, surfaced to
 * clients that need to show or hide an AI surface (the iOS Coach gate).
 *
 *   - "user"   — a personal cloud credential resolves (Codex OAuth, or a
 *                BYO OpenAI / Anthropic key).
 *   - "local"  — a per-user self-hosted base URL (Ollama / LM Studio).
 *   - "server" — no personal config, but the operator's admin-managed
 *                key serves the user. This is the case iOS #24 missed:
 *                the Coach works server-side yet the client saw `null`.
 *   - null     — nothing configured anywhere; no provider can serve.
 *
 * Read off the first entry of the presence probe: it never decrypts a key,
 * builds a client, or probes liveness.
 */
export type ProviderManagedBy = "user" | "local" | "server";

/** Where the credential behind one chain entry comes from. */
export function providerOrigin(providerType: string): ProviderManagedBy {
  if (providerType === "local") return "local";
  if (providerType === "admin-openai" || providerType === "admin-codex") {
    return "server";
  }
  return "user";
}

/**
 * What a chain that resolves empty falls back to: the OpenAI-compatible
 * gateway picked under Settings, AI, unless the chain switched it off. The
 * default chain has no entry for the gateway, so a chain never saved, reset
 * to the default, or reordered without it says nothing about the gateway.
 * Nor does a disabled gateway entry that carries a reasoning effort: that is
 * the holder the gateway form wrote for the setting
 * (`chainWithReasoningEffort`), not a switch somebody turned off; the chain
 * editor drops the effort of a gateway it switches off. Resolution and the
 * presence probe both read this, so they cannot disagree about it.
 */
export function servesPickedGateway(row: {
  aiProvider: string | null;
  aiProviderChain: unknown;
}): boolean {
  if (row.aiProvider?.toUpperCase() !== "OPENAI_COMPATIBLE") return false;
  const gateway = parseProviderChain(row.aiProviderChain ?? null).find(
    (entry) => entry.providerType === "openai-compatible",
  );
  return !gateway || gateway.enabled || gateway.reasoningEffort !== undefined;
}

/**
 * Presence-only check that the operator's central Codex is connected, over an
 * already-loaded `AppSettings` subset. No decrypt, no network.
 */
export function appSettingsCentralCodexConnected(
  settings: {
    adminCodexConnectionStatus: string | null;
    adminCodexAccessTokenEncrypted: string | null;
    adminCodexRefreshTokenEncrypted: string | null;
    adminCodexAccountIdEncrypted: string | null;
  } | null,
): boolean {
  return (
    settings?.adminCodexConnectionStatus === "connected" &&
    !!settings.adminCodexAccessTokenEncrypted &&
    !!settings.adminCodexRefreshTokenEncrypted &&
    !!settings.adminCodexAccountIdEncrypted
  );
}
