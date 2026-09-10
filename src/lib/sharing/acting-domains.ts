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
 * is the fail-closed direction.
 */
import type { Prisma } from "@/generated/prisma/client";

import { grantCoversDomain } from "@/lib/sharing/grants";
import type { ShareDomain } from "@/lib/sharing/scope";

export async function actingDomainVisibility(
  tx: Prisma.TransactionClient,
  grantId: string | null,
): Promise<(domain: ShareDomain) => boolean> {
  if (grantId === null) return () => true;
  const grant = await tx.accountGrant.findUnique({
    where: { id: grantId },
    select: { scopeJson: true },
  });
  if (!grant) return () => false;
  return (domain) => grantCoversDomain(grant, domain);
}
