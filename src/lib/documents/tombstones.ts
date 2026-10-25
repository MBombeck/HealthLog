/**
 * The two ways out of a deleted (tombstoned) vault document: back into the
 * vault, or out of the database for good.
 *
 * Delete in the vault only stamps `deletedAt`. From there a document is either
 * restored (the undo toast, Recently deleted, the bulk bar, the document
 * picker) or purged (the daily job once the grace window has passed, or the
 * person choosing "Delete now" in Recently deleted). Every one of those callers
 * goes through this module, so a restore and a purge mean the same thing
 * whoever asks:
 *
 *   - a purge copies the document's import source keys (its own and every
 *     alias) into `DocumentImportKey` in the same transaction as the delete,
 *     so an importer re-sending the document is still answered "deleted" once
 *     the row is gone;
 *   - a restore removes any `DocumentImportKey` entry for those same keys in
 *     the same transaction as clearing the tombstone. The ledger says "the
 *     person deleted this"; once the document is back, that is no longer true,
 *     and a ledger entry left behind would outlive the document's next delete
 *     and restore with nothing to explain it.
 */
import type { InboundDocumentStatus, Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { DOCUMENT_PURGE_GRACE_DAYS } from "@/lib/documents/inbound-constants";
import { isP2002 } from "@/lib/prisma-errors";

const DAY_MS = 86_400_000;

/** The moment a document deleted at `deletedAt` becomes due for the purge. */
export function documentPurgeAt(deletedAt: Date): Date {
  return new Date(deletedAt.getTime() + DOCUMENT_PURGE_GRACE_DAYS * DAY_MS);
}

interface ImportSourceKey {
  userId: string;
  sourceSystem: string;
  sourceId: string;
  sourceInstance: string | null;
}

/** The columns a row needs for {@link importKeysOf}. */
export const SOURCE_KEY_SELECT = {
  userId: true,
  sourceSystem: true,
  sourceId: true,
  sourceInstance: true,
  sourceAliases: {
    select: { sourceSystem: true, sourceId: true, sourceInstance: true },
  },
} as const;

interface KeyedRow {
  userId: string;
  sourceSystem: string | null;
  sourceId: string | null;
  sourceInstance: string | null;
  sourceAliases: Array<{
    sourceSystem: string;
    sourceId: string;
    sourceInstance: string | null;
  }>;
}

/** Every import source key a document holds: its own, then its aliases. */
export function importKeysOf(row: KeyedRow): ImportSourceKey[] {
  return [
    ...(row.sourceSystem && row.sourceId
      ? [
          {
            userId: row.userId,
            sourceSystem: row.sourceSystem,
            sourceId: row.sourceId,
            sourceInstance: row.sourceInstance,
          },
        ]
      : []),
    ...row.sourceAliases.map((alias) => ({
      userId: row.userId,
      sourceSystem: alias.sourceSystem,
      sourceId: alias.sourceId,
      sourceInstance: alias.sourceInstance,
    })),
  ];
}

/**
 * Hard-delete the tombstones `where` selects, carrying their import source
 * keys into the ledger first. Only rows with `deletedAt` set are ever touched,
 * whatever `where` says. Runs inside the caller's transaction, so a purge that
 * fails halfway forgets nothing. Returns the number of rows removed.
 */
export async function purgeDocumentTombstones(
  tx: Prisma.TransactionClient,
  where: Prisma.InboundDocumentWhereInput,
): Promise<number> {
  const tombstones: Prisma.InboundDocumentWhereInput = {
    AND: [where, { deletedAt: { not: null } }],
  };
  const keyed = await tx.inboundDocument.findMany({
    where: {
      AND: [
        tombstones,
        {
          OR: [
            { sourceSystem: { not: null }, sourceId: { not: null } },
            { sourceAliases: { some: {} } },
          ],
        },
      ],
    },
    select: SOURCE_KEY_SELECT,
  });
  const keys = keyed.flatMap(importKeysOf);
  if (keys.length > 0) {
    await tx.documentImportKey.createMany({ data: keys, skipDuplicates: true });
  }
  const { count } = await tx.inboundDocument.deleteMany({ where: tombstones });
  return count;
}

/**
 * Purge one of the person's deleted documents now, ahead of the grace window.
 * Returns false when there was no such tombstone (never existed, someone
 * else's, still live, or already gone).
 */
export async function purgeDocumentTombstoneNow(
  userId: string,
  id: string,
): Promise<boolean> {
  const count = await prisma.$transaction((tx) =>
    purgeDocumentTombstones(tx, { id, userId }),
  );
  return count > 0;
}

export type TombstoneRestoreResult =
  /** The tombstone was cleared. */
  | { kind: "restored" }
  /** The document was live already; restoring twice changes nothing. */
  | { kind: "live" }
  /** No such document for this person: purged, or never existed. */
  | { kind: "gone" }
  /** A live document with the same bytes holds the slot (null on a race). */
  | { kind: "duplicate"; existingId: string | null };

/**
 * Lifecycle status after a restore, derived from the staged facts: none →
 * STORED, any PENDING → EXTRACTED, otherwise every fact was acted on →
 * CONFIRMED. (Delete stamped DISCARDED; the status before it is not kept.)
 */
function restoredStatus(
  facts: Array<{ status: string }>,
): InboundDocumentStatus {
  if (facts.length === 0) return "STORED";
  return facts.some((f) => f.status === "PENDING") ? "EXTRACTED" : "CONFIRMED";
}

/**
 * Bring one of the person's deleted documents back into the vault, and forget
 * any ledger entry that says its import keys were deleted. Owner-scoped: a
 * foreign id is `gone`, exactly like a purged one.
 */
export async function restoreDocumentTombstone(
  userId: string,
  id: string,
): Promise<TombstoneRestoreResult> {
  const row = await prisma.inboundDocument.findFirst({
    where: { id, userId },
    select: { id: true, deletedAt: true, contentSha256: true },
  });
  if (!row) return { kind: "gone" };
  if (row.deletedAt === null) return { kind: "live" };

  // A live duplicate of the same bytes blocks the restore (the partial unique
  // index would reject it; checked first for a clean answer).
  if (row.contentSha256) {
    const conflict = await prisma.inboundDocument.findFirst({
      where: {
        userId,
        contentSha256: row.contentSha256,
        deletedAt: null,
        id: { not: id },
      },
      select: { id: true },
    });
    if (conflict) return { kind: "duplicate", existingId: conflict.id };
  }

  const facts = await prisma.extractedFact.findMany({
    where: { documentId: id, userId },
    select: { status: true },
  });

  let restored: boolean;
  try {
    restored = await prisma.$transaction(async (tx) => {
      // Guarded on the tombstone, so a purge or a restore that won the race
      // is not undone or repeated here.
      const { count } = await tx.inboundDocument.updateMany({
        where: { id, userId, deletedAt: { not: null } },
        data: { deletedAt: null, status: restoredStatus(facts) },
      });
      if (count === 0) return false;
      const keyed = await tx.inboundDocument.findUniqueOrThrow({
        where: { id },
        select: SOURCE_KEY_SELECT,
      });
      const keys = importKeysOf(keyed);
      if (keys.length > 0) {
        await tx.documentImportKey.deleteMany({ where: { OR: keys } });
      }
      return true;
    });
  } catch (err) {
    // Raced a concurrent identical upload into the partial unique index.
    if (isP2002(err)) return { kind: "duplicate", existingId: null };
    throw err;
  }
  if (restored) return { kind: "restored" };

  const now = await prisma.inboundDocument.findFirst({
    where: { id, userId },
    select: { deletedAt: true },
  });
  return now && now.deletedAt === null ? { kind: "live" } : { kind: "gone" };
}
