/**
 * Which sections of the record the caller is actually inside.
 *
 * Lives here rather than beside one feature because a route that reads or
 * writes across its own declared section is a shape the product keeps growing,
 * and its callers are already spread over four features. No list of them here:
 * a comment that enumerates its own callers is a comment that goes stale on
 * the next one. Two verbatim copies of this existed in the visits and the
 * vaccination service, with a note on the second saying a second spelling
 * would be a second thing to keep in step.
 *
 * Returns a predicate rather than a set so the owner path costs nothing: with
 * no grant there is nothing to look up and every domain is open. A grant that
 * vanished between the auth check and here answers "no" to everything, which
 * is the fail-closed direction. `record` answers true only for a grant over
 * the whole record, as `grantCoversDomain` decides.
 */
import type { Prisma } from "@/generated/prisma/client";

import { grantAllows, grantCoversDomain } from "@/lib/sharing/grant-access";
import type { ShareScope } from "@/lib/sharing/scope";

export async function actingDomainVisibility(
  tx: Prisma.TransactionClient,
  grantId: string | null,
): Promise<(domain: ShareScope) => boolean> {
  if (grantId === null) return () => true;
  const grant = await tx.accountGrant.findUnique({
    where: { id: grantId },
    select: { scopeJson: true },
  });
  if (!grant) return () => false;
  return (domain) => grantCoversDomain(grant, domain);
}

/**
 * #1403 — whether this request may use the record's guardian-only verbs: the
 * vault's upload, edits, delete and restore.
 *
 * The answer `requireRecordAuth("guardian", …)` gives, for a route that
 * resolved at a lower need and wants to shape a READ by it (the vault's usage
 * read offers Recently deleted only to whoever can restore from it). The owner
 * always may; a delegate may when the grant is a live MANAGE grant and the
 * record carries the managed-profile marker. Fail closed: a grant that vanished
 * between the auth check and here answers no.
 */
export async function actingHoldsGuardianVerbs(
  tx: Prisma.TransactionClient,
  grantId: string | null,
  record: { managedProfileAt: Date | null },
): Promise<boolean> {
  if (grantId === null) return true;
  if (record.managedProfileAt === null) return false;
  const grant = await tx.accountGrant.findUnique({
    where: { id: grantId },
    select: {
      access: true,
      acceptedAt: true,
      revokedAt: true,
      expiresAt: true,
    },
  });
  return grant !== null && grantAllows(grant, "manage");
}
