/**
 * Where a managed profile's AI work gets its provider (#1403).
 *
 * A managed profile has no credentials of its own and nobody can sign in to
 * it, so its provider chain cannot come from its own row the way an adult
 * account's does. Until this column existed it came from the operator's key
 * alone, which left a profile without any AI on an install where every
 * provider is somebody's own key. The guardian now chooses, per profile:
 *
 *   - `INSTANCE`: the operator's key, as before. The default.
 *   - `NONE`: no provider. Every capability reads `no_provider`.
 *   - `GUARDIAN`: one chain the guardian configured on their own account,
 *     either a named chain or their default chain, served with the guardian's
 *     credentials and exactly in that chain's order. No operator key is
 *     appended behind it and no gateway fallback applies: the guardian picked
 *     this chain for the profile, and a chain that cannot serve refuses
 *     rather than reaching for one nobody picked.
 *
 * The guardian's choice of a `GUARDIAN` chain counts as the guardian's
 * consent for the profile: its entries are the guardian's own keys and
 * sign-ins, which the consent rule (`consentNeeded`, `capabilities/resolve.ts`)
 * treats as self-chosen, so Coach, briefing and summaries need no separate
 * receipt of the profile's. An operator-held entry (`INSTANCE`) still needs
 * the profile's receipt at the wire (`aiEgressRefusal`), and so does every
 * document read. `NONE` is the guardian's off switch for the profile's AI.
 * The profile's module switches, usage level and call log stay its own. A
 * delegate's chain stays empty whatever this says,
 * because the credential policy (`providerCredentialPolicy`) is decided before
 * this module is asked.
 *
 * Fails closed: a guardian who no longer holds an active MANAGE grant on the
 * profile, a profile that is no longer managed, or a named chain the guardian
 * deleted all serve nothing. None of them falls back to the operator's key.
 */
import { prisma } from "@/lib/db";
import { memoizePerRequest } from "@/lib/request-cache";
import { findActiveGrant } from "@/lib/sharing/grant-access";

import { defaultChainTypes, parseNamedChains } from "./named-chains";
import type { ProviderChainType } from "./provider-chain";

export type { ManagedAiSourceKey } from "./managed-ai-source-keys";

/** Why a `GUARDIAN` choice serves nothing right now. */
export type ManagedAiUnavailableReason =
  "chosen_none" | "guardian_lost_access" | "chain_missing";

export type ManagedAiServing =
  | { kind: "instance" }
  | { kind: "none"; reason: ManagedAiUnavailableReason }
  | { kind: "guardian"; guardianId: string; chainId: string | null };

/** The guardian columns the chain choice reads. */
export interface GuardianChainRow {
  aiProvider: string | null;
  aiProviderChain: unknown;
  aiNamedChains: unknown;
  useCentralCodex: boolean;
}

/**
 * Whether `guardianId` may lend their chain to `recordId`: the record is a
 * managed profile and the guardian holds an active MANAGE grant on it.
 */
export async function guardianMayServeProfile(
  recordId: string,
  guardianId: string,
): Promise<boolean> {
  if (guardianId === recordId) return false;
  const [record, grant] = await Promise.all([
    prisma.user.findUnique({
      where: { id: recordId },
      select: { managedProfileAt: true },
    }),
    findActiveGrant({ grantorId: recordId, granteeId: guardianId }),
  ]);
  return record?.managedProfileAt != null && grant?.access === "MANAGE";
}

/**
 * The managed profile's credential source, resolved. Memoised per request,
 * so the presence probe and the chain resolution on one request agree.
 */
export function managedAiServing(recordId: string): Promise<ManagedAiServing> {
  return memoizePerRequest(
    `managed-ai-serving:${recordId}`,
    async (): Promise<ManagedAiServing> => {
      const row = await prisma.user.findUnique({
        where: { id: recordId },
        select: {
          managedAiSource: true,
          managedAiGuardianId: true,
          managedAiChainId: true,
        },
      });
      if (!row) return { kind: "none", reason: "chosen_none" };
      if (row.managedAiSource === "NONE") {
        return { kind: "none", reason: "chosen_none" };
      }
      if (row.managedAiSource !== "GUARDIAN") return { kind: "instance" };
      const guardianId = row.managedAiGuardianId;
      if (
        !guardianId ||
        !(await guardianMayServeProfile(recordId, guardianId))
      ) {
        return { kind: "none", reason: "guardian_lost_access" };
      }
      return { kind: "guardian", guardianId, chainId: row.managedAiChainId };
    },
    { freshInBackground: true },
  );
}

/**
 * The provider types the chosen guardian chain lists, in order, or `null`
 * when the named chain is gone. The central Codex counts only behind the
 * guardian's own opt-in, as it does on the guardian's account.
 */
export function guardianChainEntries(
  chainId: string | null,
  guardian: GuardianChainRow,
): ProviderChainType[] | null {
  const named = parseNamedChains(guardian.aiNamedChains ?? null);
  let entries: readonly ProviderChainType[];
  if (chainId === null) {
    entries = defaultChainTypes(named, guardian);
  } else {
    const chain = named.chains.find((candidate) => candidate.id === chainId);
    if (!chain) return null;
    entries = chain.entries;
  }
  return entries.filter(
    (type) => type !== "admin-codex" || guardian.useCentralCodex,
  );
}
