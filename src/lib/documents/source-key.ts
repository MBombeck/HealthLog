/**
 * Import source keys (#1038): where a `(sourceSystem, sourceId)` pair sent by
 * an importer already lands in a person's vault.
 *
 * A key can be held in three places, checked in this order:
 *
 *  1. the document row itself (`InboundDocument.sourceSystem/sourceId`), live
 *     or tombstoned — the key the document was stored under;
 *  2. `DocumentSourceAlias` — a further key an import sent for bytes that were
 *     already stored, so the upload answered with the existing document;
 *  3. `DocumentImportKey` — a key whose document the purge has removed.
 *
 * The first two resolve to a document (live → duplicate, tombstoned →
 * deleted); the third only to "deleted". The upload route, the lookup route
 * and the document picker all ask here, so they cannot disagree about what a
 * key means.
 *
 * v1.39.3 — a key also names its instance (`sourceInstance`, the origin of
 * the Paperless-ngx or Papra it came from): id 123 on one Paperless and id
 * 123 on another are different documents. A null on either side is a
 * wildcard, so nothing stored before the column existed is forgotten:
 *
 *   - a key stored without an instance (a v1.39.2 import, an older script, a
 *     workflow that does not send one) matches a lookup for any instance of
 *     its system;
 *   - a lookup without an instance matches a key stored for any instance.
 *
 * Where both an exact and a wildcard match exist, the exact one wins.
 */
import { prisma } from "@/lib/db";
import { checkRateLimit, type RateLimitResult } from "@/lib/rate-limit";
import type { DocumentSourceSystemValue } from "@/lib/validations/inbound-documents";
import type { SerialisableDocument } from "@/lib/documents/store";

export type SourceKeyMatch =
  | { state: "live"; document: SerialisableDocument }
  | { state: "deleted"; id: string | null };

/**
 * The instance half of a key match: the same instance or a stored key without
 * one; any instance when the lookup has none.
 */
export function instanceMatch(sourceInstance: string | null): {
  OR?: Array<{ sourceInstance: string | null }>;
} {
  return sourceInstance === null
    ? {}
    : { OR: [{ sourceInstance }, { sourceInstance: null }] };
}

/** Exact instance first, then a key stored without one (nulls sort last). */
const EXACT_FIRST = { sourceInstance: { sort: "asc", nulls: "last" } } as const;

export async function findSourceKey(
  userId: string,
  sourceSystem: DocumentSourceSystemValue,
  sourceId: string,
  sourceInstance: string | null = null,
): Promise<SourceKeyMatch | null> {
  const key = {
    userId,
    sourceSystem,
    sourceId,
    ...instanceMatch(sourceInstance),
  };
  const own = await prisma.inboundDocument.findFirst({
    where: key,
    omit: { contentEncrypted: true },
    orderBy: EXACT_FIRST,
  });
  const viaAlias = own
    ? null
    : await prisma.documentSourceAlias.findFirst({
        where: key,
        select: { document: { omit: { contentEncrypted: true } } },
        orderBy: EXACT_FIRST,
      });
  const document = own ?? viaAlias?.document ?? null;
  if (document) {
    return document.deletedAt
      ? { state: "deleted", id: document.id }
      : { state: "live", document };
  }
  const purged = await prisma.documentImportKey.findFirst({
    where: key,
    select: { id: true },
  });
  return purged ? { state: "deleted", id: null } : null;
}

/**
 * Forget the ledger's record that the person deleted the document a key named
 * (`DocumentImportKey`, written by the purge), matching instances the way
 * {@link findSourceKey} does. Only the person's own explicit "bring it back"
 * from the document picker calls this, and only once the document is in the
 * vault again; an importer's upload never does, so a deletion keeps holding
 * against every automatic re-send.
 */
export async function forgetDeletedSourceKey(
  userId: string,
  sourceSystem: DocumentSourceSystemValue,
  sourceId: string,
  sourceInstance: string | null = null,
): Promise<number> {
  const { count } = await prisma.documentImportKey.deleteMany({
    where: { userId, sourceSystem, sourceId, ...instanceMatch(sourceInstance) },
  });
  return count;
}

/**
 * How many further keys one document may collect. Real archives hold a file
 * under one or two ids; the cap stops a leaked token from growing the table
 * by sending the same bytes under id after id. Past it the upload is refused
 * (409) rather than answered without remembering the key.
 */
export const MAX_SOURCE_ALIASES_PER_DOCUMENT = 20;

/**
 * Remember that `sourceId` in `sourceSystem` was answered with `documentId`
 * (same bytes, stored earlier). Without this the key would be forgotten, and
 * once the person deleted that document the next import run would store it
 * again. Idempotent; a key already held elsewhere is left alone.
 */
export async function rememberSourceAlias(
  userId: string,
  documentId: string,
  sourceSystem: DocumentSourceSystemValue,
  sourceId: string,
  sourceInstance: string | null = null,
): Promise<"remembered" | "known" | "limit"> {
  const held = await prisma.documentSourceAlias.count({
    where: { userId, documentId },
  });
  if (held >= MAX_SOURCE_ALIASES_PER_DOCUMENT) return "limit";
  const { count } = await prisma.documentSourceAlias.createMany({
    data: [{ userId, documentId, sourceSystem, sourceInstance, sourceId }],
    skipDuplicates: true,
  });
  return count > 0 ? "remembered" : "known";
}

/**
 * Lookups of a source key per caller per hour, shared by the lookup route and
 * the upload's query-string check so neither is an unmetered way to ask.
 * Generous: an importer asks once per document, and a re-sync of a few
 * thousand documents has to fit in an hour. Keyed on the token for a
 * `documents:write` caller, on the person otherwise.
 */
const SOURCE_LOOKUP_LIMIT_PER_HOUR = 5000;
const SOURCE_LOOKUP_WINDOW_MS = 60 * 60 * 1000;

export function checkSourceLookupRateLimit(
  scoped: boolean,
  tokenId: string,
  userId: string,
): Promise<RateLimitResult> {
  return checkRateLimit(
    scoped ? `documents-source:token:${tokenId}` : `documents-source:${userId}`,
    SOURCE_LOOKUP_LIMIT_PER_HOUR,
    SOURCE_LOOKUP_WINDOW_MS,
  );
}

/**
 * What the vault holds for one source key, as the picker lists it. A deleted
 * key names its document while that is still in Recently deleted (restorable)
 * and null once the purge removed it.
 */
export type SourceKeyState =
  | { state: "imported"; documentId: string }
  | { state: "deleted"; documentId: string | null };

/**
 * {@link findSourceKey} for a page of results at once: the same three places,
 * three queries for the whole page instead of three per result. A key held by
 * a live document answers `imported` with its id; one held by a tombstone, or
 * kept by the purge ledger, answers `deleted`. A key the vault does not know
 * is absent from the map.
 */
export async function findSourceKeyStates(
  userId: string,
  sourceSystem: DocumentSourceSystemValue,
  sourceIds: string[],
  sourceInstance: string | null = null,
): Promise<Map<string, SourceKeyState>> {
  const states = new Map<string, SourceKeyState>();
  const ids = [...new Set(sourceIds)];
  if (ids.length === 0) return states;

  const where = {
    userId,
    sourceSystem,
    sourceId: { in: ids },
    ...instanceMatch(sourceInstance),
  };
  const [own, aliases, purged] = await Promise.all([
    prisma.inboundDocument.findMany({
      where,
      select: {
        id: true,
        sourceId: true,
        sourceInstance: true,
        deletedAt: true,
      },
    }),
    prisma.documentSourceAlias.findMany({
      where,
      select: {
        sourceId: true,
        sourceInstance: true,
        document: { select: { id: true, deletedAt: true } },
      },
    }),
    prisma.documentImportKey.findMany({
      where,
      select: { sourceId: true },
    }),
  ]);
  // A wildcard (instance-less) row first, so an exact-instance row after it
  // wins, as it does in `findSourceKey`.
  const wildcardFirst = <T extends { sourceInstance: string | null }>(
    rows: T[],
  ) =>
    [...rows].sort(
      (a, b) =>
        Number(a.sourceInstance === sourceInstance) -
        Number(b.sourceInstance === sourceInstance),
    );

  // Lowest precedence first, so the document's own key wins, as it does in
  // `findSourceKey`.
  for (const row of purged) {
    states.set(row.sourceId, { state: "deleted", documentId: null });
  }
  for (const row of wildcardFirst(aliases)) {
    states.set(
      row.sourceId,
      row.document.deletedAt
        ? { state: "deleted", documentId: row.document.id }
        : { state: "imported", documentId: row.document.id },
    );
  }
  for (const row of wildcardFirst(own)) {
    if (!row.sourceId) continue;
    states.set(
      row.sourceId,
      row.deletedAt
        ? { state: "deleted", documentId: row.id }
        : { state: "imported", documentId: row.id },
    );
  }
  return states;
}
