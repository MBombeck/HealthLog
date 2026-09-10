/**
 * Which sections of the record the caller is actually inside.
 *
 * Lives here rather than beside one feature because three unrelated seams ask
 * it — a visit's link labels, a vaccination's, and the cycle crosstab's
 * outcome columns — and a route that reads across its own declared section is
 * a shape the product will keep growing. Two verbatim copies of it already
 * existed in the visits and vaccination services; a third would have been the
 * one that drifted.
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
