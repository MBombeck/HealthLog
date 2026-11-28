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
    // The backup reads through this select, and its export is totally ordered.
    orderBy: [
      { createdAt: "asc" },
      { id: "asc" },
    ] as Prisma.DocumentSourceAliasOrderByWithRelationInput[],
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

/**
 * {@link restoreDocumentTombstone} over many documents at once, for the bulk
 * route. Same rules and the same per-id outcomes, in a bounded number of
 * statements whatever the batch size: three reads (the tombstones with their
 * import keys, the live duplicates of their bytes, their staged facts) and
 * one transaction holding one guarded update per restored status and one
 * ledger cleanup.
 *
 * Two tombstones in the batch holding the same bytes cannot both come back
 * (the partial unique index allows one live copy); the first in `ids` order
 * wins and the next reads as a duplicate of it, as it would have one by one.
 * A concurrent upload racing the transaction into that index fails the whole
 * transaction; the batch then falls back to the one-by-one restore, which
 * reports that race per id.
 */
export async function restoreDocumentTombstones(
  userId: string,
  ids: readonly string[],
): Promise<Map<string, TombstoneRestoreResult>> {
  const results = new Map<string, TombstoneRestoreResult>();
  if (ids.length === 0) return results;

  const rows = await prisma.inboundDocument.findMany({
    where: { id: { in: [...ids] }, userId },
    select: { id: true, deletedAt: true, contentSha256: true },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  const tombstones = ids.flatMap((id) => {
    const row = byId.get(id);
    if (!row) results.set(id, { kind: "gone" });
    else if (row.deletedAt === null) results.set(id, { kind: "live" });
    else return [row];
    return [];
  });
  if (tombstones.length === 0) return results;

  // Bytes already held by a live document, then claimed in `ids` order.
  const shas = [
    ...new Set(
      tombstones.flatMap((row) =>
        row.contentSha256 ? [row.contentSha256] : [],
      ),
    ),
  ];
  const holders = new Map<string, string>();
  if (shas.length > 0) {
    const live = await prisma.inboundDocument.findMany({
      where: { userId, deletedAt: null, contentSha256: { in: shas } },
      select: { id: true, contentSha256: true },
    });
    for (const row of live) {
      if (row.contentSha256 && !holders.has(row.contentSha256)) {
        holders.set(row.contentSha256, row.id);
      }
    }
  }
  const restorable: string[] = [];
  for (const row of tombstones) {
    const holder = row.contentSha256 ? holders.get(row.contentSha256) : null;
    if (holder) {
      results.set(row.id, { kind: "duplicate", existingId: holder });
      continue;
    }
    if (row.contentSha256) holders.set(row.contentSha256, row.id);
    restorable.push(row.id);
  }
  if (restorable.length === 0) return results;

  const facts = await prisma.extractedFact.findMany({
    where: { documentId: { in: restorable }, userId },
    select: { documentId: true, status: true },
  });
  const factsByDoc = new Map<string, Array<{ status: string }>>();
  for (const fact of facts) {
    const list = factsByDoc.get(fact.documentId) ?? [];
    list.push(fact);
    factsByDoc.set(fact.documentId, list);
  }
  const byStatus = new Map<InboundDocumentStatus, string[]>();
  for (const id of restorable) {
    const status = restoredStatus(factsByDoc.get(id) ?? []);
    byStatus.set(status, [...(byStatus.get(status) ?? []), id]);
  }

  let restored: Set<string>;
  try {
    restored = await prisma.$transaction(async (tx) => {
      const done = new Set<string>();
      for (const [status, group] of byStatus) {
        // Guarded on the tombstone, so a purge or a restore that won the race
        // is not undone or repeated here.
        const updated = await tx.inboundDocument.updateManyAndReturn({
          where: { id: { in: group }, userId, deletedAt: { not: null } },
          data: { deletedAt: null, status },
          select: { id: true },
        });
        for (const row of updated) done.add(row.id);
      }
      if (done.size === 0) return done;
      const keyed = await tx.inboundDocument.findMany({
        where: {
          id: { in: [...done] },
          userId,
          OR: [
            { sourceSystem: { not: null }, sourceId: { not: null } },
            { sourceAliases: { some: {} } },
          ],
        },
        select: SOURCE_KEY_SELECT,
      });
      const keys = keyed.flatMap(importKeysOf);
      if (keys.length > 0) {
        await tx.documentImportKey.deleteMany({ where: { OR: keys } });
      }
      return done;
    });
  } catch (err) {
    if (!isP2002(err)) throw err;
    for (const id of restorable) {
      results.set(id, await restoreDocumentTombstone(userId, id));
    }
    return results;
  }

  // A tombstone the guarded update did not clear was restored or purged by
  // someone else in between: live now, or gone.
  const raced = restorable.filter((id) => !restored.has(id));
  const nowLive =
    raced.length === 0
      ? new Set<string>()
      : new Set(
          (
            await prisma.inboundDocument.findMany({
              where: { id: { in: raced }, userId, deletedAt: null },
              select: { id: true },
            })
          ).map((row) => row.id),
        );
  for (const id of restorable) {
    results.set(
      id,
      restored.has(id)
        ? { kind: "restored" }
        : nowLive.has(id)
          ? { kind: "live" }
          : { kind: "gone" },
    );
  }
  return results;
}
