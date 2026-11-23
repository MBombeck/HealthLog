/**
 * Whether a standing link a guardian made for a managed profile still holds.
 *
 * A calendar feed or an emergency card link is minted under
 * `requireGuardianAuth`: by the record's owner, or by the guardian of a
 * managed profile (a live MANAGE grant on a record that carries the
 * managed-profile marker). The link outlives the request that made it, so
 * whatever admitted the guardian is read again every time it is served: the
 * guardian's account, the grant, and the marker. A guardian who loses the
 * grant, or a profile handed over to its own person, ends the link on the
 * next fetch or scan. A link the owner made rests on nothing of this.
 *
 * The cycle feed checks the same thing inline, with its own section check
 * (`cycle/feed/serve.ts`).
 */
import { activeAccount } from "@/lib/account-deletion/active-account";
import { prisma } from "@/lib/db";
import { findActiveGrant, grantAllows } from "@/lib/sharing/grant-access";

/** Null when the link still holds, else why it does not. */
export async function guardianMintRefusal(link: {
  userId: string;
  createdById: string;
}): Promise<string | null> {
  if (link.createdById === link.userId) return null;
  const [subject, carrier, grant] = await Promise.all([
    prisma.user.findFirst({
      where: activeAccount({ id: link.userId }),
      select: { managedProfileAt: true },
    }),
    prisma.user.findFirst({
      where: activeAccount({ id: link.createdById }),
      select: { id: true },
    }),
    findActiveGrant({ grantorId: link.userId, granteeId: link.createdById }),
  ]);
  if (!subject || subject.managedProfileAt === null) return "not_managed";
  if (!carrier) return "carrier";
  if (!grant || !grantAllows(grant, "manage")) return "grant";
  return null;
}
