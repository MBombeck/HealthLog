/**
 * A key-rotation walk that loses the row it paged from still reads the rest.
 *
 * The corpus walk and the rotation script paged with Prisma's
 * `cursor: { id }, skip: 1`. Prisma resolves that cursor by looking the row up
 * again, so when the row a page ended on was hard-deleted before the next
 * page (a backup replaced, an idempotency entry expired), the next page came
 * back empty. The walk ended early and the scan reported fewer rows, possibly
 * "nothing left on the old key", while rows it never read were still under
 * it. The walks page by `id > last id` now, which needs no row to exist.
 *
 * Mutation check: put the `cursor`/`skip` paging back in `walkColumn` and the
 * scan counts one page of rows instead of all of them.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { newChunkStreamId, sealBackupChunk } from "@/lib/export/backup-chunks";
import { ENCRYPTED_COLUMNS } from "@/lib/crypto/encrypted-columns";
import {
  BLOB_ROTATION_BATCH_SIZE,
  scanColumn,
  type CorpusClient,
} from "@/lib/crypto/encryption-corpus";
import { getPrismaClient, truncateAllTables } from "./setup";

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
});

describe("encryption corpus walk", () => {
  it("reads every row even when the row a page ended on is deleted", async () => {
    const prisma = getPrismaClient();
    const user = await prisma.user.create({
      data: { username: "cursor-walk", email: "cursor-walk@example.test" },
    });
    const count = BLOB_ROTATION_BATCH_SIZE + 5;
    // The pieces of one stored backup: a blob column walked in small pages.
    const backup = await prisma.dataBackup.create({
      data: {
        userId: user.id,
        type: "WEEKLY_AUTO",
        data: null,
        chunkCount: count,
        chunkStreamId: newChunkStreamId(),
      },
    });
    const streamId = newChunkStreamId();
    await prisma.dataBackupChunk.createMany({
      data: Array.from({ length: count }, (_, i) => ({
        id: `piece-${String(i).padStart(3, "0")}`,
        backupId: backup.id,
        seq: i,
        data: new Uint8Array(
          sealBackupChunk(streamId, i, i === count - 1, Buffer.from(`${i}`)),
        ),
      })),
    });

    let pages = 0;
    const client = {
      dataBackupChunk: {
        findMany: async (args: never) => {
          const rows = (await prisma.dataBackupChunk.findMany(args)) as Array<{
            id: string;
          }>;
          pages += 1;
          // The first page's last row disappears before the second is read.
          if (pages === 1 && rows.length > 0) {
            await prisma.dataBackupChunk.delete({
              where: { id: rows.at(-1)!.id },
            });
          }
          return rows;
        },
        update: (args: never) => prisma.dataBackupChunk.update(args),
      },
    } as unknown as CorpusClient;

    const col = ENCRYPTED_COLUMNS.find(
      (c) => c.model === "DataBackupChunk" && c.field === "data",
    )!;
    const scan = await scanColumn(client, col);

    // Every row was read once: the deleted one on the first page, the rest
    // on the pages after it.
    expect(scan.total).toBe(count);
    expect(pages).toBeGreaterThan(1);
  });
});
