/**
 * The life of an Apple Wallet pass (v1.50): whether it is live, and
 * withdrawing it inside a caller's transaction. A light module, so the
 * credential remediations, the managed-profile handover, the account
 * deletion, the QR link's guardian check and the queues can read and stamp a
 * pass without loading the pass builder.
 *
 * A pass is live while it is not withdrawn (its own stamp or its link's) and
 * its link has not expired. {@link walletPassState} is that rule on a row
 * that is read already, {@link livePassWhere} the same rule as a filter; a
 * test holds the two together. Every reader of "this record has a live pass"
 * goes through one of them: the card's routes, `/api/auth/me`, the ready
 * push, the refresh after a card write, the sweep and the web service.
 */
import type { Prisma } from "@/generated/prisma/client";

export type WalletPassVoidReason =
  | "OWNER"
  | "CREDENTIAL_RESET"
  | "HANDOVER"
  | "GUARDIAN_LOST"
  | "ACCOUNT_DELETION";

export type WalletPassState = "live" | "voided" | "expired";

/** What the rule reads of a pass. */
export interface WalletPassLife {
  voidedAt: Date | null;
  link: { revokedAt: Date | null; expiresAt: Date | null };
}

/**
 * When the pass stopped counting: its own stamp, else its link's. A link
 * ended by a credential remediation ends the pass with it, so the pass is
 * withdrawn from that moment even before its own row is stamped.
 */
export function walletPassVoidedAt(
  row: Pick<WalletPassLife, "voidedAt"> & {
    link: Pick<WalletPassLife["link"], "revokedAt">;
  },
): Date | null {
  return row.voidedAt ?? row.link.revokedAt;
}

export function walletPassState(
  row: WalletPassLife,
  now: Date = new Date(),
): WalletPassState {
  if (walletPassVoidedAt(row)) return "voided";
  const expires = row.link.expiresAt;
  return expires && expires.getTime() <= now.getTime() ? "expired" : "live";
}

/** {@link walletPassState} `=== "live"` at `now`, as a filter on passes. */
export function livePassWhere(
  now: Date = new Date(),
): Prisma.WalletPassWhereInput {
  return {
    voidedAt: null,
    link: {
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
  };
}

/**
 * Stamp the passes `where` matches as withdrawn, in the caller's transaction,
 * with their links: what the credential remediations, the handover and the
 * account deletion do beside their own revocations. The caller (or, within
 * minutes, the void-push cron) tells the devices.
 */
export async function voidWalletPassesWhere(
  tx: Pick<Prisma.TransactionClient, "walletPass" | "emergencyCardLink">,
  where: Prisma.WalletPassWhereInput,
  reason: WalletPassVoidReason,
  now: Date = new Date(),
): Promise<number> {
  const passes = await tx.walletPass.findMany({
    where: { AND: [where, { voidedAt: null }] },
    select: { id: true, linkId: true },
  });
  if (passes.length === 0) return 0;
  await tx.emergencyCardLink.updateMany({
    where: {
      id: { in: passes.map((p) => p.linkId) },
      purpose: "WALLET",
      revokedAt: null,
    },
    data: { revokedAt: now },
  });
  await tx.walletPass.updateMany({
    where: { id: { in: passes.map((p) => p.id) }, voidedAt: null },
    data: { voidedAt: now, voidReason: reason },
  });
  return passes.length;
}

/**
 * Withdraw the record's expired passes, in the caller's transaction: what a
 * new pass replaces. An expired pass keeps its link unrevoked until then, and
 * the one-live-link index would refuse the new one.
 */
export function voidExpiredWalletPasses(
  tx: Pick<Prisma.TransactionClient, "walletPass" | "emergencyCardLink">,
  userId: string,
  now: Date = new Date(),
): Promise<number> {
  return voidWalletPassesWhere(
    tx,
    { userId, link: { expiresAt: { lte: now } } },
    "OWNER",
    now,
  );
}
