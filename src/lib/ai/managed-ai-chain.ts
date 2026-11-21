/**
 * The provider-presence row and, for #1403, the managed profile served by a
 * chain its guardian lends: the parts of `provider.ts` that need no client
 * construction of their own, kept beside it.
 *
 * `resolveGuardianChain` is handed the entry resolver by `provider.ts`, which
 * owns client construction, so this module never builds a provider itself.
 */
import type { Prisma } from "@/generated/prisma/client";
import {
  AI_CAPABILITY_KEYS,
  type AiCapabilityKey,
} from "@/lib/ai/capabilities/types";
import type {
  ProviderEntryPresence,
  ProviderPresence,
} from "@/lib/ai/capabilities/resolve";
import { prisma } from "@/lib/db";
import {
  appSettingsCentralCodexConnected,
  readOperatorRow,
} from "@/lib/settings/operator-row";

import { logChainCalls } from "./chain-call-log";
import { chainEntryReadsImages } from "./codex-slug-chain";
import { bindResponseTimeout } from "./effective-timeout";
import { guardianChainEntries } from "./managed-ai-source";
import type { ProviderChainType } from "./provider-chain";
import { providerOrigin } from "./provider-egress";
import type { ProviderChainResolved } from "./provider-runner";
import { bindReasoningEffort } from "./reasoning-effort";
import type { AIProvider } from "./types";

/** Builds one chain entry from the guardian's credentials. */
export type GuardianEntryResolver = (
  providerType: ProviderChainType,
  guardianId: string,
  guardian: Prisma.UserGetPayload<{ select: typeof GUARDIAN_CHAIN_SELECT }>,
) => Promise<AIProvider | null>;

/** The guardian columns a lent chain is resolved from. */
export const GUARDIAN_CHAIN_SELECT = {
  aiProvider: true,
  aiModel: true,
  aiLocalBaseUrl: true,
  aiLocalModel: true,
  aiAnthropicKeyEncrypted: true,
  aiLocalKeyEncrypted: true,
  aiOpenaiKeyEncrypted: true,
  aiCompatBaseUrl: true,
  aiCompatKeyEncrypted: true,
  aiCompatModel: true,
  role: true,
  aiProviderChain: true,
  aiNamedChains: true,
  useCentralCodex: true,
  aiResponseTimeoutSeconds: true,
} as const;

/**
 * #1403 — a managed profile served by its guardian's chain: exactly the
 * entries of the chain the guardian picked, with the guardian's credentials,
 * model, timeout and reasoning effort, in that order and nothing else.
 * Pinned, so the runner neither reorders nor appends behind it.
 */
export async function resolveGuardianChain(
  serving: { guardianId: string; chainId: string | null },
  capability: AiCapabilityKey | null,
  resolveEntry: GuardianEntryResolver,
): Promise<ProviderChainResolved[]> {
  const label = {
    chain: `guardian:${serving.chainId ?? "default"}`,
    capability,
  };
  const guardian = await prisma.user.findUnique({
    where: { id: serving.guardianId },
    select: GUARDIAN_CHAIN_SELECT,
  });
  if (!guardian) return [];
  const entries = guardianChainEntries(serving.chainId, guardian);
  if (!entries) return [];
  const bind = (provider: AIProvider): AIProvider =>
    bindReasoningEffort(
      bindResponseTimeout(provider, guardian.aiResponseTimeoutSeconds),
      guardian.aiProviderChain,
    );
  const resolved: ProviderChainResolved[] = [];
  for (const providerType of entries) {
    const instance = await resolveEntry(
      providerType,
      serving.guardianId,
      guardian,
    );
    if (instance) {
      resolved.push({
        providerType,
        instance: logChainCalls(bind(instance), providerType, label),
        pinned: true,
      });
    }
  }
  return resolved;
}

/** The credential-presence columns the probe reads off the record's row. */
export const PRESENCE_USER_SELECT = {
  aiProvider: true,
  aiProviderChain: true,
  aiNamedChains: true,
  aiAnthropicKeyEncrypted: true,
  aiLocalKeyEncrypted: true,
  aiOpenaiKeyEncrypted: true,
  aiLocalBaseUrl: true,
  aiLocalModel: true,
  aiCompatBaseUrl: true,
  aiCompatModel: true,
  aiModel: true,
  codexConnectionStatus: true,
  codexAccessTokenEncrypted: true,
  codexRefreshTokenEncrypted: true,
  useCentralCodex: true,
  managedProfileAt: true,
  labsLocalOcrEnabled: true,
  aiResponseTimeoutSeconds: true,
} as const;

export const NO_PRESENCE: ProviderPresence = Object.freeze({
  entries: [],
  localOcrEnabled: false,
  managedBy: null,
  availableTypes: [],
});

/**
 * Whether one chain entry's model can read an image. Mirrors the model each
 * entry runs on (`src/lib/labs/ocr-capability.ts`): each Codex path asks its
 * own sign-in, the operator's slot uses the operator's model, Local its own
 * (`aiLocalModel`), every other entry the person's shared `aiModel`.
 */
export function entryVision(
  providerType: string,
  recordId: string,
  models: {
    user: string | null;
    local: string | null;
    admin: string | null;
  },
): boolean {
  const model =
    providerType === "admin-openai"
      ? models.admin
      : providerType === "local"
        ? models.local
        : models.user;
  return chainEntryReadsImages(providerType, recordId, model);
}

export type PresenceRow = NonNullable<
  Prisma.UserGetPayload<{ select: typeof PRESENCE_USER_SELECT }>
>;

/** Whether a row holds a usable credential for one chain entry. */
export function credentialPresenceOf(
  row: PresenceRow,
  adminKey: boolean,
): (providerType: ProviderChainType) => boolean {
  const codexConnected =
    row.codexConnectionStatus === "connected" &&
    !!row.codexAccessTokenEncrypted &&
    !!row.codexRefreshTokenEncrypted;
  return (providerType) => {
    switch (providerType) {
      case "codex":
        return codexConnected;
      case "openai":
        return !!row.aiOpenaiKeyEncrypted;
      case "anthropic":
        return !!row.aiAnthropicKeyEncrypted;
      case "local":
        return !!row.aiLocalBaseUrl;
      case "openai-compatible":
        return !!(row.aiCompatBaseUrl && (row.aiCompatModel || row.aiModel));
      case "admin-openai":
        return adminKey;
      default:
        // `admin-codex` is never resolved from a stored chain entry.
        return false;
    }
  };
}

/**
 * #1403 — presence of the guardian chain a managed profile is served by,
 * mirroring `resolveGuardianChain`: the chosen chain's entries the guardian
 * holds a credential for, each capability pinned to that one chain. The
 * guardian's in-browser OCR is not the profile's opt-in to use.
 */
export async function guardianChainPresence(
  serving: { guardianId: string; chainId: string | null },
  settings: Awaited<ReturnType<typeof readOperatorRow>>,
  record: PresenceRow,
): Promise<ProviderPresence> {
  const guardian = await prisma.user.findUnique({
    where: { id: serving.guardianId },
    select: PRESENCE_USER_SELECT,
  });
  if (!guardian) return NO_PRESENCE;
  const chain = guardianChainEntries(serving.chainId, guardian);
  if (!chain) return NO_PRESENCE;
  const adminKey = !!settings?.adminAiKeyEncrypted;
  const credentialPresent = credentialPresenceOf(guardian, adminKey);
  const centralCodex = appSettingsCentralCodexConnected(settings);
  const present = (type: ProviderChainType) =>
    type === "admin-codex" ? centralCodex : credentialPresent(type);
  const vision = (providerType: string): ProviderEntryPresence => ({
    providerType,
    vision: entryVision(providerType, serving.guardianId, {
      user: guardian.aiModel,
      local: guardian.aiLocalModel,
      admin: settings?.adminAiModel ?? null,
    }),
  });
  const entries = chain.filter(present).map(vision);
  const pinned: Partial<Record<AiCapabilityKey, ProviderEntryPresence[]>> = {};
  for (const key of AI_CAPABILITY_KEYS) pinned[key] = entries;
  const head = entries[0];
  return {
    entries,
    pinned,
    localOcrEnabled: false,
    managedBy: head ? providerOrigin(head.providerType) : null,
    availableTypes: chain.filter(present),
    responseTimeoutSeconds:
      guardian.aiResponseTimeoutSeconds ?? record.aiResponseTimeoutSeconds,
    operatorKeyBaseUrl: settings?.adminAiBaseUrl ?? null,
  };
}
