/**
 * The vault list read behind `GET /api/documents/inbound`: title/filename
 * search unioned with a whole-word content match, kind / episode / visit /
 * year / date-range filters, sort, and keyset pagination. It NEVER selects
 * the encrypted blob column.
 */
import type { z } from "zod/v4";

import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { listPage } from "@/lib/http/list-query";
import { annotate } from "@/lib/logging/context";
import { hashQueryTokens } from "@/lib/documents/content-index";
import { isoDateToUtc } from "@/lib/documents/ingest";
import {
  loadConditionLinks,
  loadDocumentEncounterLinks,
} from "@/lib/documents/links";
import { serialiseDocument } from "@/lib/documents/store";
import {
  toContentIndexSource,
  type documentListQuerySchema,
} from "@/lib/validations/inbound-documents";

type VaultListQuery = z.infer<typeof documentListQuerySchema>;

function listWhere(
  userId: string,
  query: VaultListQuery,
): Prisma.InboundDocumentWhereInput {
  const { q, kind, episodeId, encounterId, year, from, to } = query;
  const where: Prisma.InboundDocumentWhereInput = {
    userId,
    deletedAt: null,
  };
  if (kind && kind.length > 0) where.kind = { in: kind };
  if (episodeId) where.conditionLinks = { some: { episodeId } };
  // The visit filter reads the SAME table the visit's own sheet writes, from
  // the document side. Filtering rather than post-filtering: a page of fifty
  // documents narrowed in Node would page wrongly.
  if (encounterId) where.encounterLinks = { some: { encounterId } };
  if (year !== undefined) {
    where.documentDate = {
      gte: new Date(Date.UTC(year, 0, 1)),
      lt: new Date(Date.UTC(year + 1, 0, 1)),
    };
  } else if (from || to) {
    where.documentDate = {
      ...(from ? { gte: isoDateToUtc(from) } : {}),
      // inclusive end-of-day for the `to` bound
      ...(to ? { lt: new Date(isoDateToUtc(to).getTime() + 86_400_000) } : {}),
    };
  }
  if (q) {
    // Substring match on the short plaintext fields …
    const or: Prisma.InboundDocumentWhereInput[] = [
      { title: { contains: q, mode: "insensitive" } },
      { filename: { contains: q, mode: "insensitive" } },
    ];
    // … unioned with a WHOLE-WORD content match over the blind token index.
    // The query is tokenised + HMAC'd the same way the index was built, then
    // matched with a GIN-accelerated array-overlap (`hasSome` → `&&`). The
    // list still never selects the encrypted text: only the opaque hashes
    // are touched, in the related table. Degrades silently to title/filename
    // when the caller has no indexed documents (no rows overlap).
    const hashes = hashQueryTokens(q);
    if (hashes.length > 0) {
      or.push({ contentIndex: { is: { searchTokens: { hasSome: hashes } } } });
    }
    where.OR = or;
  }
  return where;
}

/**
 * The sort column of a page; nullable sort columns sort nulls last so
 * undated documents trail.
 */
function primaryOrder(
  query: VaultListQuery,
): Prisma.InboundDocumentOrderByWithRelationInput {
  const { sort, order } = query;
  return sort === "documentDate"
    ? { documentDate: { sort: order, nulls: "last" } }
    : sort === "title"
      ? { title: { sort: order, nulls: "last" } }
      : { createdAt: order };
}

/**
 * Fact tallies for the whole page in ONE grouped count: no per-document
 * fan-out and no materialising fact-id rows. `factCount` counts every
 * non-REJECTED fact (a rejected fact is discarded, not part of the
 * document's tally), `pendingCount` the PENDING subset awaiting review.
 */
async function pageFactCounts(
  userId: string,
  pageIds: string[],
): Promise<Map<string, { factCount: number; pendingCount: number }>> {
  const factCounts = new Map<
    string,
    { factCount: number; pendingCount: number }
  >();
  if (pageIds.length === 0) return factCounts;
  const groups = await prisma.extractedFact.groupBy({
    by: ["documentId", "status"],
    where: { userId, documentId: { in: pageIds } },
    _count: { _all: true },
  });
  for (const g of groups) {
    const entry = factCounts.get(g.documentId) ?? {
      factCount: 0,
      pendingCount: 0,
    };
    const n = g._count._all;
    if (g.status !== "REJECTED") entry.factCount += n;
    if (g.status === "PENDING") entry.pendingCount += n;
    factCounts.set(g.documentId, entry);
  }
  return factCounts;
}

export async function listVaultDocuments(
  userId: string,
  query: VaultListQuery,
) {
  const { q, kind, episodeId, encounterId, year, sort, order, cursor } = query;
  const where = listWhere(userId, query);
  // Keyset pagination on the sort column + a stable `id` tiebreak.
  const orderBy: Prisma.InboundDocumentOrderByWithRelationInput[] = [
    primaryOrder(query),
    { id: order },
  ];

  // Hardening: the list NEVER fetches the encrypted blob column; a page of
  // 50 rows would otherwise drag up to 50 × cap ciphertext bytes per request.
  const { rows: page, cap } = await listPage(query.limit, (take) =>
    prisma.inboundDocument.findMany({
      where,
      omit: { contentEncrypted: true },
      orderBy,
      take,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    }),
  );

  const hasMore = cap.truncated;
  const nextCursor = hasMore ? (page[page.length - 1]?.id ?? null) : null;

  const pageIds = page.map((d) => d.id);
  const factCounts = await pageFactCounts(userId, pageIds);

  // Condition/visit links + the content-index and thumbnail probes for the
  // page, all in ONE Promise.all: four independent grouped queries (no N+1,
  // never a ciphertext/blob column), and the vault polls this list every few
  // seconds so two serialized round-trips were pure added latency.
  const [linkMap, visitLinkMap, indexedRows, thumbRows] = await Promise.all([
    loadConditionLinks(userId, pageIds),
    loadDocumentEncounterLinks(userId, pageIds),
    // Which of the page's documents have a content index (drives the
    // searchable status + the provenance the UI reads to tell an AI-read
    // document from a locally-indexed one).
    page.length > 0
      ? prisma.documentContentIndex.findMany({
          where: { userId, documentId: { in: pageIds } },
          select: { documentId: true, source: true },
        })
      : Promise.resolve([]),
    // Which of the page's documents have a preview thumbnail (gates the
    // card's <img>). Grouped on the 1:1 side table.
    page.length > 0
      ? prisma.documentThumbnail.findMany({
          where: { userId, documentId: { in: pageIds } },
          select: { documentId: true },
        })
      : Promise.resolve([]),
  ]);
  const indexSources = new Map<string, string>();
  for (const row of indexedRows) indexSources.set(row.documentId, row.source);
  const thumbnailIds = new Set<string>();
  for (const row of thumbRows) thumbnailIds.add(row.documentId);

  annotate({
    action: { name: "documents.inbound.list" },
    meta: {
      count: page.length,
      sort,
      order,
      filtered: Boolean(
        q || (kind && kind.length > 0) || episodeId || encounterId || year,
      ),
    },
  });

  return {
    documents: page.map((doc) =>
      serialiseDocument(
        doc,
        factCounts.get(doc.id) ?? { factCount: 0, pendingCount: 0 },
        linkMap.get(doc.id) ?? [],
        indexSources.has(doc.id),
        toContentIndexSource(indexSources.get(doc.id)),
        thumbnailIds.has(doc.id),
        visitLinkMap.get(doc.id) ?? [],
      ),
    ),
    nextCursor,
  };
}
