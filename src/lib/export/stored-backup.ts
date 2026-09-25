/**
 * Read a stored backup (`data_backups` + `data_backup_chunks`) back as its
 * JSON, whichever form it was stored in.
 *
 * Two forms exist. From v1.39.2 a copy is a run of sealed pieces
 * (`backup-chunks.ts`), read here one piece at a time, so a copy of any size
 * passes through this process a megabyte at a time. Before that a copy was one
 * value in `data_backups.data`; `openBackupBlob` still opens those as it
 * always did. Nothing converts the old form: the weekly copy is replaced in
 * the new form by the next weekly run, and an uploaded copy stays readable as
 * it is until someone deletes it.
 *
 * Integrity before anything else. `openStoredBackup` walks every piece once
 * before it hands out a source: each is authenticated, and each has to name
 * this copy, its own position, and (for the last) that it is the last. A copy
 * with a piece missing, moved, altered, borrowed from another copy or cut
 * short is refused there, which is before any restore deletes a row. Every
 * later read through the source checks each piece again as it goes, so a copy
 * replaced while a restore was running fails that read too, and the restore's
 * transaction rolls back rather than writing a mixture.
 */
import { Readable, pipeline } from "node:stream";
import { createGunzip } from "node:zlib";

import type { PrismaClient } from "@/generated/prisma/client";
import { openBackupBlob } from "@/lib/export/backup-blob";
import {
  BackupIntegrityError,
  openBackupChunk,
} from "@/lib/export/backup-chunks";
import type { BackupSource } from "@/lib/export/streamed-backup";

/** The columns a reader needs to open a stored copy, in either form. */
export const STORED_BACKUP_SELECT = {
  id: true,
  userId: true,
  data: true,
  chunkCount: true,
  chunkStreamId: true,
} as const;

export interface StoredBackupRef {
  id: string;
  userId: string;
  data: string | null;
  chunkCount: number | null;
  chunkStreamId: string | null;
}

type ChunkReader = Pick<PrismaClient, "dataBackupChunk">;

/**
 * A value that changes whenever the stored copy is replaced, for the restore
 * job's check that the copy it was asked to restore is still the one there.
 * For a chunked copy that is its stream id, which a new copy always changes
 * and a key rotation never does; for a single-value copy it is the value.
 */
export function storedBackupIdentity(backup: StoredBackupRef): string {
  if (backup.chunkStreamId != null) {
    return `chunks:${backup.chunkStreamId}:${backup.chunkCount ?? ""}`;
  }
  return backup.data ?? "";
}

/** The pieces of one chunked copy, opened and checked, in order. */
async function* openedChunks(
  prisma: ChunkReader,
  backupId: string,
  streamId: string,
  count: number,
): AsyncGenerator<Buffer> {
  for (let seq = 0; seq < count; seq++) {
    const row = await prisma.dataBackupChunk.findUnique({
      where: { backupId_seq: { backupId, seq } },
      select: { data: true },
    });
    if (!row) {
      throw new BackupIntegrityError(
        `Piece ${seq} of ${count} of the stored copy is missing.`,
      );
    }
    yield openBackupChunk(row.data, {
      streamId,
      seq,
      last: seq === count - 1,
    });
  }
}

/**
 * Open a stored copy as a source of its JSON bytes, openable as many times as
 * the caller needs. Rejects when the copy cannot be read whole: a key that is
 * no longer configured, or a copy whose pieces do not add up (see the module
 * comment). Nothing of the JSON is released before that check has passed.
 */
export async function openStoredBackup(
  prisma: ChunkReader,
  backup: StoredBackupRef,
): Promise<BackupSource> {
  if (backup.chunkStreamId == null || backup.chunkCount == null) {
    if (backup.data == null) {
      throw new BackupIntegrityError("The stored copy has no content.");
    }
    return openBackupBlob(backup.data);
  }
  const { id, chunkStreamId: streamId, chunkCount: count } = backup;
  if (count < 1) {
    throw new BackupIntegrityError("The stored copy lists no pieces.");
  }
  // Pieces beyond the count would be ignored by the reads below, but they are
  // not something this code ever writes, so their presence is refused too.
  const stored = await prisma.dataBackupChunk.count({
    where: { backupId: id },
  });
  if (stored !== count) {
    throw new BackupIntegrityError(
      `The stored copy lists ${count} pieces but ${stored} are stored.`,
    );
  }
  // The whole copy, checked once before anyone reads a byte of it.
  for await (const piece of openedChunks(prisma, id, streamId, count)) {
    void piece;
  }

  return () => {
    const gunzip = createGunzip();
    // `pipeline`, not `pipe`: a piece that fails its check has to fail the
    // reader, and `pipe` would leave the reader waiting for an end that never
    // comes.
    pipeline(
      Readable.from(openedChunks(prisma, id, streamId, count)),
      gunzip,
      () => {},
    );
    return gunzip;
  };
}
