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

import { isStreamCiphertext, openStreamDecryptor } from "@/lib/crypto";
import {
  BackupBusyError,
  packBackupChunks,
  packGzipChunks,
  singleValueToGzip,
  type BackupJsonProducer,
  type PackBackupOptions,
} from "@/lib/export/backup-blob";
import {
  BackupIntegrityError,
  newChunkStreamId,
} from "@/lib/export/backup-chunks";
import { BackupFormsConflictError } from "@/lib/export/stored-backup";

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

type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

/** Refuse to touch a copy an unfinished restore is reading. */
async function assertNotBeingRestored(tx: Tx, backupId: string) {
  const active = await tx.backupRestoreJob.findFirst({
    where: { backupId, status: { in: ["queued", "running"] } },
    select: { id: true },
  });
  if (active) throw new BackupBusyError(backupId);
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
      await assertNotBeingRestored(tx, row.id);
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

      // Again at the end: a restore may have been queued while this ran. The
      // window left is the few milliseconds to the commit, and a restore
      // started in it finds the copy changed (`backup_changed`) or, if it is
      // already reading, is told the copy was replaced while being read.
      await assertNotBeingRestored(tx, row.id);
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

/**
 * The first characters of a single stored value, which carry its key id, or
 * null when the row no longer holds one. For the key-rotation scan, which must
 * not read a value that can be a hundred megabytes whole.
 */
export async function singleValueBackupHead(
  prisma: PrismaClient,
  id: string,
): Promise<string | null> {
  const [row] = await prisma.$queryRaw<Array<{ head: string | null }>>`
    SELECT left(data, 64) AS head FROM data_backups WHERE id = ${id}
  `;
  return row?.head ?? null;
}

/**
 * How much of a single stored value the conversion reads per query, in
 * characters. A multiple of four, so every slice of base64 decodes on its own.
 */
const CONVERT_SLICE_CHARS = 1024 * 1024;

/**
 * Turn a copy stored as one value (before v1.39.2) into sealed pieces under
 * the active key, in place: same row, same date. Resolves to `"gone"` when the
 * row no longer holds a single value (converted, replaced or deleted since it
 * was listed).
 *
 * Why convert rather than re-seal. Re-sealing a single value under the new key
 * needs the stored string, its decoded bytes, the plaintext and the new
 * ciphertext at once, and one value can be a hundred megabytes; key rotation
 * runs in the app container. Converting reads the value a slice at a time and
 * writes pieces as it goes.
 *
 * The single stream of v1.38.6 to v1.39.1 is read in slices and its tag is checked only at
 * the end, so the pieces are written before the check has passed. That is why
 * all of it is one transaction: a copy that fails the check rolls back, and
 * the row is left exactly as it was. The older forms were written from one
 * string and fit in one, so they are read whole.
 */
export async function convertSingleValueBackup(
  prisma: PrismaClient,
  id: string,
  /** Characters per read; a multiple of four. Tests lower it. */
  sliceChars: number = CONVERT_SLICE_CHARS,
): Promise<"converted" | "gone"> {
  if (sliceChars % 4 !== 0) throw new Error("sliceChars must divide by 4");
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(
        `SET LOCAL idle_in_transaction_session_timeout = '${STORE_IDLE_TIMEOUT}'`,
      );
      const [row] = await tx.$queryRaw<
        Array<{ head: string; len: number; stream_id: string | null }>
      >`
        SELECT left(data, 128) AS head, length(data)::int AS len,
               chunk_stream_id AS stream_id
        FROM data_backups
        WHERE id = ${id} AND data IS NOT NULL
        FOR UPDATE
      `;
      if (!row) return "gone";
      if (row.stream_id !== null) {
        throw new BackupFormsConflictError();
      }

      let gz: AsyncIterable<Buffer> | Iterable<Buffer>;
      if (isStreamCiphertext(row.head)) {
        const decryptor = openStreamDecryptor(row.head);
        const slice = async (from: number): Promise<Buffer> => {
          const [part] = await tx.$queryRaw<Array<{ s: string }>>`
            SELECT substr(data, ${from + 1}::int, ${sliceChars}::int) AS s
            FROM data_backups WHERE id = ${id}
          `;
          return Buffer.from(part?.s ?? "", "base64");
        };
        gz = (async function* () {
          // The last 16 bytes of the body are the tag, so they are held back
          // from every slice until the next one shows they were not the end.
          let held = Buffer.alloc(0);
          for (let at = decryptor.headerLength; at < row.len;) {
            const bytes = Buffer.concat([held, await slice(at)]);
            at += sliceChars;
            const cut = Math.max(0, bytes.byteLength - 16);
            held = Buffer.from(bytes.subarray(cut));
            const out = decryptor.update(bytes.subarray(0, cut));
            if (out.byteLength > 0) yield out;
          }
          if (held.byteLength !== 16) {
            throw new BackupIntegrityError("The stored copy is truncated.");
          }
          const tail = decryptor.final(held);
          if (tail.byteLength > 0) yield tail;
        })();
      } else {
        const whole = await tx.dataBackup.findUniqueOrThrow({
          where: { id },
          select: { data: true },
        });
        gz = [singleValueToGzip(whole.data!)];
      }

      await tx.dataBackupChunk.deleteMany({ where: { backupId: id } });
      const streamId = newChunkStreamId();
      const { chunks } = await packGzipChunks(
        async (sealed, seq) => {
          await tx.dataBackupChunk.create({
            data: { backupId: id, seq, data: new Uint8Array(sealed) },
            select: { id: true },
          });
        },
        streamId,
        gz,
        // The copy exists already; converting it must not be refused by the
        // limit on writing a new one.
        { maxBytes: Number.MAX_SAFE_INTEGER },
      );
      await tx.dataBackup.update({
        where: { id },
        data: { data: null, chunkCount: chunks, chunkStreamId: streamId },
      });
      return "converted";
    },
    { timeout: STORE_TRANSACTION_TIMEOUT_MS, maxWait: 60_000 },
  );
}
