/**
 * The stored row a vault upload answers with (`POST /api/documents/inbound`),
 * serialised with its condition and visit links: a fresh insert with no facts
 * yet, or the existing live row a duplicate resolved to, with its fact
 * tallies.
 */
import { prisma } from "@/lib/db";
import {
  loadConditionLinks,
  loadDocumentEncounterLinks,
} from "@/lib/documents/links";
import {
  serialiseDocument,
  type SerialisableDocument,
} from "@/lib/documents/store";

/** The existing row a duplicate upload resolved to. */
export async function duplicateDocumentBody(
  userId: string,
  existing: SerialisableDocument,
) {
  const [links, visitLinks, groups] = await Promise.all([
    loadConditionLinks(userId, [existing.id]),
    loadDocumentEncounterLinks(userId, [existing.id]),
    prisma.extractedFact.groupBy({
      by: ["status"],
      where: { userId, documentId: existing.id },
      _count: { _all: true },
    }),
  ]);
  let factCount = 0;
  let pendingCount = 0;
  for (const g of groups) {
    if (g.status !== "REJECTED") factCount += g._count._all;
    if (g.status === "PENDING") pendingCount += g._count._all;
  }
  return serialiseDocument(
    existing,
    { factCount, pendingCount },
    links.get(existing.id) ?? [],
    false,
    null,
    false,
    visitLinks.get(existing.id) ?? [],
  );
}

/** A row the upload just stored. */
export async function storedDocumentBody(
  userId: string,
  document: SerialisableDocument,
) {
  const [links, visitLinks] = await Promise.all([
    loadConditionLinks(userId, [document.id]),
    loadDocumentEncounterLinks(userId, [document.id]),
  ]);
  return serialiseDocument(
    document,
    { factCount: 0, pendingCount: 0 },
    links.get(document.id) ?? [],
    false,
    null,
    false,
    visitLinks.get(document.id) ?? [],
  );
}
