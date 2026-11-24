/**
 * The restore end of the three visit link tables (document, lab result,
 * condition episode), kept apart from `visits-backup.ts`, whose restore calls
 * it once the encounters are back. The export end stays there.
 */
import type { Prisma } from "@/generated/prisma/client";

import {
  recordUnknownKeys,
  type RestoreSkipLog,
} from "@/lib/export/restore-skips";
import type {
  EncounterLinkBackupEntry,
  VisitsRestoreInput,
} from "@/lib/export/visits-backup";

/**
 * Write the links whose two ends came back, and name the rest. MUST run after
 * the encounters and after the documents, lab results and condition episodes.
 */
export async function restoreEncounterLinks(
  tx: Prisma.TransactionClient,
  ownerId: string,
  payload: Pick<
    VisitsRestoreInput,
    "encounterDocumentLinks" | "encounterLabLinks" | "encounterConditionLinks"
  >,
  restoredEncounters: ReadonlySet<string>,
  skips: RestoreSkipLog,
): Promise<void> {
  /**
   * Write the links whose far side actually came back, and name the rest.
   *
   * The far side is checked against the database rather than against the
   * payload, because the document, the lab result and the episode are restored
   * by other branches in the same transaction and this is the only place that
   * can see all three.
   */
  async function restoreLinks(
    entries: EncounterLinkBackupEntry[],
    existingTargetIds: Set<string>,
    write: (
      rows: Array<{
        encounterId: string;
        targetId: string;
        createdAt: Date;
      }>,
    ) => Promise<void>,
  ): Promise<void> {
    const writable: Array<{
      encounterId: string;
      targetId: string;
      createdAt: Date;
    }> = [];
    const dropped: string[] = [];
    for (const entry of entries) {
      if (
        restoredEncounters.has(entry.encounterId) &&
        existingTargetIds.has(entry.targetId)
      ) {
        writable.push({
          encounterId: entry.encounterId,
          targetId: entry.targetId,
          createdAt: new Date(entry.createdAt),
        });
      } else {
        dropped.push(entry.targetId);
      }
    }
    if (writable.length > 0) await write(writable);
    recordUnknownKeys(skips, "visitReference", [...new Set(dropped)], dropped);
  }

  const [documentIds, labResultIds, episodeIds] = await Promise.all([
    tx.inboundDocument.findMany({
      where: { userId: ownerId },
      select: { id: true },
    }),
    tx.labResult.findMany({
      where: { userId: ownerId },
      select: { id: true },
    }),
    tx.illnessEpisode.findMany({
      where: { userId: ownerId },
      select: { id: true },
    }),
  ]);

  await restoreLinks(
    payload.encounterDocumentLinks,
    new Set(documentIds.map((row) => row.id)),
    async (rows) => {
      await tx.encounterDocumentLink.createMany({
        data: rows.map((row) => ({
          userId: ownerId,
          encounterId: row.encounterId,
          documentId: row.targetId,
          createdAt: row.createdAt,
        })),
      });
    },
  );

  await restoreLinks(
    payload.encounterLabLinks,
    new Set(labResultIds.map((row) => row.id)),
    async (rows) => {
      await tx.encounterLabLink.createMany({
        data: rows.map((row) => ({
          userId: ownerId,
          encounterId: row.encounterId,
          labResultId: row.targetId,
          createdAt: row.createdAt,
        })),
      });
    },
  );

  await restoreLinks(
    payload.encounterConditionLinks,
    new Set(episodeIds.map((row) => row.id)),
    async (rows) => {
      await tx.encounterConditionLink.createMany({
        data: rows.map((row) => ({
          userId: ownerId,
          encounterId: row.encounterId,
          episodeId: row.targetId,
          createdAt: row.createdAt,
        })),
      });
    },
  );
}
