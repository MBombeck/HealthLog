/**
 * The one writer of an in-database account copy.
 *
 * The weekly pass and the copy a data wipe takes first both store the whole
 * record through here, so the two cannot drift into different shapes: what an
 * admin restores after a wipe is exactly what the weekly copy would have been
 * at that moment.
 *
 * Streamed, compressed, then encrypted (the record contains sensitive health
 * information), and stored a piece at a time. Nothing between the database
 * rows and the stored copy exists as a whole in this process: the payload
 * goes into gzip a page at a time, and gzip's output is sealed and stored in
 * pieces of about a megabyte (`storeBackupBlob`). The copy is kept as those
 * pieces, so its size does not depend on this process's memory (#1031). The
 * restore preview is taken from the writer's own counts and the sections as
 * they are written, never by parsing the copy.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { createBackupPreviewCollector } from "@/lib/export/backup-preview";
import type { FullBackupCounts } from "@/lib/export/full-backup-payload";
import { streamFullBackupJson } from "@/lib/export/full-backup-stream";
import { storeBackupBlob } from "@/lib/export/store-backup-blob";

/**
 * Store `userId`'s whole record as the `(userId, type)` copy, replacing that
 * copy if it exists. Resolves to the row's id, its stored size in bytes and
 * the number of pieces.
 */
export async function writeAccountCopy(
  prisma: PrismaClient,
  userId: string,
  type: string,
): Promise<{ id: string; bytes: number; chunks: number }> {
  const preview = await createBackupPreviewCollector();
  let counts: FullBackupCounts | undefined;
  return storeBackupBlob(
    prisma,
    {
      userId,
      type,
      preview: () => (counts ? preview.finish(counts) : null),
    },
    async (write) => {
      counts = await streamFullBackupJson(prisma, userId, write, {
        purpose: "disaster-recovery",
        observe: preview.observe,
      });
    },
  );
}
