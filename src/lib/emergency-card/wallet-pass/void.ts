/**
 * Withdrawing Apple Wallet passes inside a caller's transaction (v1.50). A
 * light module, so the credential remediations, the managed-profile
 * handover, the account deletion and the QR link's guardian check can stamp
 * a pass without loading the pass builder.
 */
import type { Prisma } from "@/generated/prisma/client";

export type WalletPassVoidReason =
  | "OWNER"
  | "CREDENTIAL_RESET"
  | "HANDOVER"
  | "GUARDIAN_LOST"
  | "ACCOUNT_DELETION";

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
