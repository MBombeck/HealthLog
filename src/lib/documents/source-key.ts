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
 * deleted); the third only to "deleted". The upload route and the lookup
 * route both ask here, so they cannot disagree about what a key means.
 */
import { prisma } from "@/lib/db";
import { checkRateLimit, type RateLimitResult } from "@/lib/rate-limit";
import type { DocumentSourceSystemValue } from "@/lib/validations/inbound-documents";
import type { SerialisableDocument } from "@/lib/documents/store";

export type SourceKeyMatch =
  | { state: "live"; document: SerialisableDocument }
  | { state: "deleted"; id: string | null };

export async function findSourceKey(
  userId: string,
  sourceSystem: DocumentSourceSystemValue,
  sourceId: string,
): Promise<SourceKeyMatch | null> {
  const own = await prisma.inboundDocument.findFirst({
    where: { userId, sourceSystem, sourceId },
    omit: { contentEncrypted: true },
  });
  const viaAlias = own
    ? null
    : await prisma.documentSourceAlias.findUnique({
        where: {
          userId_sourceSystem_sourceId: { userId, sourceSystem, sourceId },
        },
        select: { document: { omit: { contentEncrypted: true } } },
      });
  const document = own ?? viaAlias?.document ?? null;
  if (document) {
    return document.deletedAt
      ? { state: "deleted", id: document.id }
      : { state: "live", document };
  }
  const purged = await prisma.documentImportKey.findUnique({
    where: {
      userId_sourceSystem_sourceId: { userId, sourceSystem, sourceId },
    },
    select: { id: true },
  });
  return purged ? { state: "deleted", id: null } : null;
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
): Promise<"remembered" | "known" | "limit"> {
  const held = await prisma.documentSourceAlias.count({
    where: { userId, documentId },
  });
  if (held >= MAX_SOURCE_ALIASES_PER_DOCUMENT) return "limit";
  const { count } = await prisma.documentSourceAlias.createMany({
    data: [{ userId, documentId, sourceSystem, sourceId }],
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
