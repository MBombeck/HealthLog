/**
 * #1403 — the `aiSource` record-settings family: which provider a managed
 * profile's AI work uses, chosen by its guardian.
 *
 * The read answers the profile's choice and, for the guardian reading it, the
 * options they could pick: their own named chains (id and name, nothing
 * about credentials) and whether the operator's key exists. The write stores
 * the choice field by field; picking a guardian chain records the guardian
 * acting as the lender, so a second guardian's chains never serve the profile
 * behind the first one's back. The resolver re-checks the grant on every
 * resolution (`src/lib/ai/managed-ai-source.ts`), so a guardian who loses
 * access stops serving at once, without this row changing.
 */
import { prisma } from "@/lib/db";
import { parseNamedChains } from "@/lib/ai/named-chains";
import {
  guardianMayServeProfile,
  type ManagedAiSourceKey,
} from "@/lib/ai/managed-ai-source";
import { readOperatorRow } from "@/lib/settings/operator-row";

import { parseManagedRecordSettingsPatch } from "./configuration";

export class ManagedAiSourceChainError extends Error {
  constructor() {
    super("The chosen chain does not exist on your account");
    this.name = "ManagedAiSourceChainError";
  }
}

export interface ManagedAiSourceSettings {
  source: ManagedAiSourceKey;
  /** The named chain under `GUARDIAN`; null = the guardian's default chain. */
  chainId: string | null;
  /** Whether the reading guardian is the one whose chain serves. */
  servedByYou: boolean;
  /** Under `GUARDIAN`, whether the lender's chain can still serve. */
  guardianChainUsable: boolean;
  /** The reading guardian's own named chains, to pick from. */
  yourChains: Array<{ id: string; name: string }>;
  /** Whether the operator has set an instance key. */
  instanceKeyConfigured: boolean;
}

export async function readManagedAiSourceSettings(
  recordId: string,
  actorId: string,
): Promise<ManagedAiSourceSettings> {
  const [record, actor, operator] = await Promise.all([
    prisma.user.findUnique({
      where: { id: recordId },
      select: {
        managedAiSource: true,
        managedAiGuardianId: true,
        managedAiChainId: true,
      },
    }),
    prisma.user.findUnique({
      where: { id: actorId },
      select: { aiNamedChains: true },
    }),
    readOperatorRow(),
  ]);
  const source = record?.managedAiSource ?? "INSTANCE";
  const lender = source === "GUARDIAN" ? record?.managedAiGuardianId : null;
  let guardianChainUsable = false;
  if (lender) {
    guardianChainUsable = await guardianMayServeProfile(recordId, lender);
    if (guardianChainUsable && record?.managedAiChainId) {
      const lenderRow =
        lender === actorId
          ? actor
          : await prisma.user.findUnique({
              where: { id: lender },
              select: { aiNamedChains: true },
            });
      guardianChainUsable = parseNamedChains(
        lenderRow?.aiNamedChains ?? null,
      ).chains.some((chain) => chain.id === record.managedAiChainId);
    }
  }
  return {
    source,
    chainId: source === "GUARDIAN" ? (record?.managedAiChainId ?? null) : null,
    servedByYou: lender === actorId,
    guardianChainUsable,
    yourChains: parseNamedChains(actor?.aiNamedChains ?? null).chains.map(
      (chain) => ({ id: chain.id, name: chain.name }),
    ),
    instanceKeyConfigured: !!operator?.adminAiKeyEncrypted,
  };
}

/**
 * Store the guardian's choice. Returns the settings as they now read and the
 * closed facts the audit row records: the source and whether a named chain or
 * the default chain was picked, never a chain's name.
 */
export async function patchManagedAiSourceSettings(
  recordId: string,
  actorId: string,
  body: unknown,
): Promise<{
  settings: ManagedAiSourceSettings;
  changed: readonly string[];
  audit: Record<string, string>;
}> {
  const patch = parseManagedRecordSettingsPatch("aiSource", body);
  const chainId = patch.source === "GUARDIAN" ? (patch.chainId ?? null) : null;
  if (chainId !== null) {
    const actor = await prisma.user.findUnique({
      where: { id: actorId },
      select: { aiNamedChains: true },
    });
    const exists = parseNamedChains(actor?.aiNamedChains ?? null).chains.some(
      (chain) => chain.id === chainId,
    );
    if (!exists) throw new ManagedAiSourceChainError();
  }
  await prisma.user.update({
    where: { id: recordId },
    data: {
      managedAiSource: patch.source,
      managedAiGuardianId: patch.source === "GUARDIAN" ? actorId : null,
      managedAiChainId: chainId,
    },
  });
  return {
    settings: await readManagedAiSourceSettings(recordId, actorId),
    changed: ["source"],
    audit: {
      source: patch.source,
      chain:
        patch.source !== "GUARDIAN"
          ? "none"
          : chainId === null
            ? "default"
            : "named",
    },
  };
}
