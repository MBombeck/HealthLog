/**
 * Write one account's stored backup (`data_backups.data`) without ever
 * holding the stored copy in this process.
 *
 * Why. `packBackupBlobStreaming` streams the JSON through gzip and the cipher,
 * but its answer is one string, because the column takes one value. Measured
 * on a seeded account of 1.25 million measurements: the answer is 64 MB of
 * base64, and between the pieces, the joined string and the copies the
 * database driver makes to bind it, the backup grew the process by about
 * 640 MB of resident memory (309 MB → 946 MB). The default compose stack runs
 * the web server and the worker in one container capped at 1 GB, so on a
 * record of that size the weekly or manual backup is the thing that takes the
 * container down; a killed worker leaves its job `active` until pg-boss
 * expires it two hours later as `job timed out`.
 *
 * What instead. The pieces go to Postgres as they come, a few megabytes at a
 * time, into a temporary table on the transaction's own connection, and one
 * statement assembles them into the row with `string_agg`. The process never
 * holds more than one piece; Postgres builds the value it was going to store
 * anyway.
 *
 * All of it is one transaction, so the account's previous copy stays in place
 * until the new one is complete: a failure halfway through rolls back to it,
 * and the temporary table goes with the transaction either way.
 */
import type { PrismaClient } from "@/generated/prisma/client";

import {
  packBackupBlobInto,
  type BackupJsonProducer,
  type PackBackupBlobOptions,
} from "@/lib/export/backup-blob";

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
}

/**
 * Pack `producer`'s JSON into the stored envelope and upsert it as the
 * account's `(userId, type)` backup. Resolves to the stored size in bytes.
 */
export async function storeBackupBlob(
  prisma: PrismaClient,
  input: StoreBackupBlobInput,
  producer: BackupJsonProducer,
  options: PackBackupBlobOptions = {},
): Promise<number> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(
        `SET LOCAL idle_in_transaction_session_timeout = '${STORE_IDLE_TIMEOUT}'`,
      );
      await tx.$executeRaw`
        CREATE TEMP TABLE backup_blob_parts (
          seq integer PRIMARY KEY,
          piece text NOT NULL
        ) ON COMMIT DROP
      `;

      let seq = 0;
      let bytes = 0;
      await packBackupBlobInto(
        async (piece) => {
          await tx.$executeRaw`
            INSERT INTO backup_blob_parts (seq, piece) VALUES (${seq}, ${piece})
          `;
          seq += 1;
          bytes += piece.length;
        },
        producer,
        options,
      );

      // The row first, through Prisma, so a new account's backup gets its id
      // the same way every other row does; the data it briefly carries is
      // never visible outside this transaction.
      await tx.dataBackup.upsert({
        where: { userId_type: { userId: input.userId, type: input.type } },
        update: { createdAt: new Date() },
        create: { userId: input.userId, type: input.type, data: "" },
      });
      await tx.$executeRaw`
        UPDATE data_backups
        SET data = (
          SELECT string_agg(piece, '' ORDER BY seq) FROM backup_blob_parts
        )
        WHERE user_id = ${input.userId} AND type = ${input.type}
      `;
      return bytes;
    },
    { timeout: STORE_TRANSACTION_TIMEOUT_MS, maxWait: 60_000 },
  );
}
