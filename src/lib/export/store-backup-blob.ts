/**
 * Write one account's stored backup without ever holding the stored copy in
 * this process.
 *
 * The copy goes into `data_backup_chunks` as sealed pieces of about a
 * megabyte (`packBackupChunks`, the piece format in `backup-chunks.ts`), so
 * this process holds one piece at a time and the size of a copy has nothing to
 * do with the memory of the process that writes it. Up to v1.39.1 the pieces
 * were joined into one value in `data_backups.data`, which every reader then
 * had to take whole; that capped a copy at a fifth of the heap, 105 MB in the
 * default 1 GB container, and an account with 1.75 million readings was past
 * it (#1031).
 *
 * All of it is one transaction, so the account's previous copy stays in place,
 * readable, until the new one is complete: a failure halfway through rolls
 * back to it.
 *
 * The pieces are written through the model API, never through a raw query.
 * Prisma caches the plan of every raw query keyed by its parameter values, the
 * last hundred of them, so a raw INSERT carrying a one-megabyte piece keeps
 * that piece alive after the statement: measured, a hundred such inserts left
 * 160 MB of heap behind that no collection frees, which is the memory bound
 * this module exists to remove. A model create is planned once for its shape
 * and keeps nothing.
 */
import type { PrismaClient } from "@/generated/prisma/client";

import {
  packBackupChunks,
  type BackupJsonProducer,
  type PackBackupOptions,
} from "@/lib/export/backup-blob";
import { newChunkStreamId } from "@/lib/export/backup-chunks";

/**
 * How long the storing transaction may stay open. The job around it expires
 * after two hours (`DATA_BACKUP_SEND_OPTIONS`); the transaction has to give
 * up before that so the failure is the transaction's own, with its own
 * message, rather than an expired job.
 */
const STORE_TRANSACTION_TIMEOUT_MS = 90 * 60 * 1000;

/**
 * How long the transaction may sit idle between two pieces. The session
 * default (`idle_in_transaction_session_timeout`, 60 s, see `src/lib/db.ts`)
 * is right for a request and wrong here: the producer reads the whole record
 * on other connections while this one waits for the next piece, and the
 * sections before the first measurement can take longer than a minute on a
 * large account. Scoped with SET LOCAL, so it ends with the transaction.
 */
const STORE_IDLE_TIMEOUT = "10min";

export interface StoreBackupBlobInput {
  userId: string;
  /** `DataBackup.type`: `WEEKLY_AUTO` for the scheduled and manual pass. */
  type: string;
  /**
   * The account the copy belongs to, when it is known only once the producer
   * has finished: an uploaded file names its owner inside itself. The row is
   * written under `userId` meanwhile (the uploading admin) and moved to this
   * account before the transaction commits, so nothing outside it ever sees
   * the row under the wrong owner.
   */
  ownerAfterRead?: () => string;
}

/**
 * Pack `producer`'s JSON into sealed pieces and store them as the
 * `(userId, type)` backup, replacing that backup's previous copy. Resolves to
 * the row's id, the stored size in bytes and the number of pieces.
 */
export async function storeBackupBlob(
  prisma: PrismaClient,
  input: StoreBackupBlobInput,
  producer: BackupJsonProducer,
  options: PackBackupOptions = {},
): Promise<{ id: string; bytes: number; chunks: number }> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(
        `SET LOCAL idle_in_transaction_session_timeout = '${STORE_IDLE_TIMEOUT}'`,
      );
      // The row first, so the pieces have something to belong to. An existing
      // copy is cleared here, inside the transaction: outside it the previous
      // copy stays whole and readable until this one commits.
      const row = await tx.dataBackup.upsert({
        where: { userId_type: { userId: input.userId, type: input.type } },
        update: { data: null },
        create: { userId: input.userId, type: input.type, data: null },
        select: { id: true },
      });
      await tx.dataBackupChunk.deleteMany({ where: { backupId: row.id } });

      const streamId = newChunkStreamId();
      const { chunks, bytes } = await packBackupChunks(
        async (sealed, seq) => {
          await tx.dataBackupChunk.create({
            data: { backupId: row.id, seq, data: new Uint8Array(sealed) },
            select: { id: true },
          });
        },
        streamId,
        producer,
        options,
      );

      await tx.dataBackup.update({
        where: { id: row.id },
        data: {
          ...(input.ownerAfterRead ? { userId: input.ownerAfterRead() } : {}),
          chunkCount: chunks,
          chunkStreamId: streamId,
          createdAt: new Date(),
        },
      });
      return { id: row.id, bytes, chunks };
    },
    { timeout: STORE_TRANSACTION_TIMEOUT_MS, maxWait: 60_000 },
  );
}
