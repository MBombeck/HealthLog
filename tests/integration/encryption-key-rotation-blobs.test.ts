/**
 * Key rotation over the two ciphertext columns that carry no `*Encrypted` in
 * their name, against real Postgres.
 *
 * `DataBackup.data` is the one that matters. It holds the whole account,
 * compressed then encrypted, and it sat outside the rotation registry until
 * v1.38.6 — the script reported zero rows remaining because it never looked,
 * and the runbook reads a zero as permission to retire the previous key. This
 * pins the fix at the level the bug lived at: seed real rows under an old key,
 * rotate, and read the backup back.
 *
 * Every single-value envelope is seeded on purpose: `encrypt(json)`, the
 * `HLZ1:` gzip form and the `~hlgcm1.` stream of v1.38.6 to v1.39.1. Rotation does not
 * re-seal them in place, which would hold a whole copy several times over; it
 * converts each into pieces under the active key, reading the value a slice
 * at a time, and the copy has to read back byte-identical.
 *
 * `IdempotencyKey.responseBody` rides along as the disposable case: a row
 * under a key the deployment no longer configures is DELETED rather than
 * counted as an error, because the value is a 24h cache entry and leaving it
 * behind only guarantees the next replay gets a body it cannot parse.
 */
import { beforeEach, describe, expect, it } from "vitest";

process.env.ENCRYPTION_KEYS = JSON.stringify({
  v1: "1".repeat(64),
  v2: "2".repeat(64),
});
process.env.ENCRYPTION_ACTIVE_KEY_ID = "v1";
delete process.env.ENCRYPTION_KEY;

import { _resetCryptoCacheForTests, encrypt, extractKeyId } from "@/lib/crypto";
import {
  ENCRYPTED_COLUMNS,
  encryptedColumnKey,
  type EncryptedColumn,
} from "@/lib/crypto/encrypted-columns";
import {
  rotateColumn,
  scanColumn,
  type CorpusClient,
} from "@/lib/crypto/encryption-corpus";
import { packBackupBlob } from "@/lib/export/backup-blob";
import { extractKeyIdFromBytes } from "@/lib/crypto";
import {
  convertSingleValueBackup,
  storeBackupBlob,
} from "@/lib/export/store-backup-blob";
import { legacyStreamedBlob } from "@/__tests__/helpers/legacy-backup-blob";
import { getPrismaClient, truncateAllTables } from "./setup";
import { readStoredBackup } from "./stored-backup-read";

const TEST_USER_ID = "user-rotation-blobs";
const BACKUP_JSON = JSON.stringify({
  schemaVersion: 7,
  measurements: [{ type: "WEIGHT", value: 80.4, unit: "kg" }],
  note: "üäö — a non-ASCII payload, so a mangled round-trip shows up",
});

function column(model: string, field: string): EncryptedColumn {
  const col = ENCRYPTED_COLUMNS.find(
    (c) => c.model === model && c.field === field,
  );
  if (!col) throw new Error(`${model}.${field} is not registered`);
  return col;
}

/** Encrypt while `keyId` is active, then restore the caller's active id. */
function underKey(keyId: string, plaintext: string, pack = false): string {
  const previous = process.env.ENCRYPTION_ACTIVE_KEY_ID;
  process.env.ENCRYPTION_ACTIVE_KEY_ID = keyId;
  _resetCryptoCacheForTests();
  const out = pack ? packBackupBlob(plaintext) : encrypt(plaintext);
  process.env.ENCRYPTION_ACTIVE_KEY_ID = previous;
  _resetCryptoCacheForTests();
  return out;
}

beforeEach(async () => {
  process.env.ENCRYPTION_KEYS = JSON.stringify({
    v1: "1".repeat(64),
    v2: "2".repeat(64),
  });
  process.env.ENCRYPTION_ACTIVE_KEY_ID = "v2";
  _resetCryptoCacheForTests();
  await truncateAllTables(getPrismaClient());
  await getPrismaClient().user.create({
    data: {
      id: TEST_USER_ID,
      username: "rotation-blobs",
      email: "rotation-blobs@example.test",
      timezone: "Europe/Berlin",
    },
  });
});

describe("key rotation over the non-suffixed ciphertext columns", () => {
  /**
   * Rotation converts a single-value copy into pieces rather than re-sealing
   * it in place. Re-sealing needs the whole value in memory several times
   * over, and the in-app rotation runs in the same 1 GB container as
   * everything else; converting reads the value a slice at a time.
   */
  async function expectConverted(id: string, createdAt: Date) {
    const prisma = getPrismaClient();
    const row = await prisma.dataBackup.findUniqueOrThrow({ where: { id } });
    expect(row.data).toBeNull();
    expect(row.chunkCount).toBeGreaterThan(0);
    expect(row.chunkStreamId).toMatch(/^[0-9a-f]{32}$/);
    // The copy is still the one taken on that date.
    expect(row.createdAt).toEqual(createdAt);
    for (const piece of await prisma.dataBackupChunk.findMany({
      where: { backupId: id },
    })) {
      expect(extractKeyIdFromBytes(Buffer.from(piece.data))).toBe("v2");
    }
    expect(await readStoredBackup(prisma, id)).toBe(BACKUP_JSON);
  }

  it("converts DataBackup.data in every single-value envelope into pieces under the active key", async () => {
    const prisma = getPrismaClient();
    const previous = process.env.ENCRYPTION_ACTIVE_KEY_ID;
    process.env.ENCRYPTION_ACTIVE_KEY_ID = "v1";
    _resetCryptoCacheForTests();
    // The single stream of v1.38.6 to v1.39.1, whose key id sits behind a `~hlgcm1.`
    // marker the string codec's parser does not read.
    const streamed = legacyStreamedBlob(BACKUP_JSON);
    process.env.ENCRYPTION_ACTIVE_KEY_ID = previous;
    _resetCryptoCacheForTests();
    const rows = [
      await prisma.dataBackup.create({
        data: {
          userId: TEST_USER_ID,
          type: "WEEKLY_AUTO",
          data: underKey("v1", BACKUP_JSON, true),
        },
      }),
      // The pre-envelope shape: `encrypt(json)` with no `HLZ1:` marker.
      await prisma.dataBackup.create({
        data: {
          userId: TEST_USER_ID,
          type: "MANUAL_UPLOAD_1",
          data: underKey("v1", BACKUP_JSON),
        },
      }),
      await prisma.dataBackup.create({
        data: { userId: TEST_USER_ID, type: "MANUAL_UPLOAD_2", data: streamed },
      }),
      // Already under the active key: converted too, so no single value is
      // left for a reader that has to hold it whole.
      await prisma.dataBackup.create({
        data: {
          userId: TEST_USER_ID,
          type: "MANUAL_UPLOAD_3",
          data: underKey("v2", BACKUP_JSON, true),
        },
      }),
    ];

    const result = await rotateColumn(
      prisma as unknown as CorpusClient,
      column("DataBackup", "data"),
    );
    expect(result).toMatchObject({
      scanned: 4,
      rotated: 4,
      errors: 0,
      dropped: 0,
    });

    // What the runbook tells the operator to do next: retire v1 entirely.
    process.env.ENCRYPTION_KEYS = JSON.stringify({ v2: "2".repeat(64) });
    _resetCryptoCacheForTests();
    for (const row of rows) await expectConverted(row.id, row.createdAt);

    // Idempotent: a second pass finds nothing left to do.
    const again = await rotateColumn(
      prisma as unknown as CorpusClient,
      column("DataBackup", "data"),
    );
    expect(again).toMatchObject({ scanned: 0, rotated: 0, errors: 0 });
  });

  it("converts a single stream read in many small slices, the tag straddling one", async () => {
    const prisma = getPrismaClient();
    const json = JSON.stringify({
      rows: Array.from({ length: 3_000 }, (_, i) => ({ i, r: Math.random() })),
    });
    const stored = legacyStreamedBlob(json);
    const header = stored.indexOf(".", "~hlgcm1.".length) + 17;
    const body = stored.length - header;
    for (const slice of [64, 1_024, body - (body % 4) - 8]) {
      const row = await prisma.dataBackup.create({
        data: { userId: TEST_USER_ID, type: `MANUAL_${slice}`, data: stored },
      });
      expect(await convertSingleValueBackup(prisma, row.id, slice)).toBe(
        "converted",
      );
      expect(await readStoredBackup(prisma, row.id)).toBe(json);
    }
  });

  it("leaves a single-value copy that fails its check exactly as it was", async () => {
    const prisma = getPrismaClient();
    const previous = process.env.ENCRYPTION_ACTIVE_KEY_ID;
    process.env.ENCRYPTION_ACTIVE_KEY_ID = "v1";
    _resetCryptoCacheForTests();
    const streamed = legacyStreamedBlob(BACKUP_JSON);
    process.env.ENCRYPTION_ACTIVE_KEY_ID = previous;
    _resetCryptoCacheForTests();
    // Alter one character of the ciphertext body: the tag at the end no
    // longer verifies, which the conversion only learns after the last slice.
    const at = streamed.length - 40;
    const altered =
      streamed.slice(0, at) +
      (streamed[at] === "A" ? "B" : "A") +
      streamed.slice(at + 1);
    const row = await prisma.dataBackup.create({
      data: { userId: TEST_USER_ID, type: "WEEKLY_AUTO", data: altered },
    });

    const result = await rotateColumn(
      prisma as unknown as CorpusClient,
      column("DataBackup", "data"),
    );
    expect(result).toMatchObject({ scanned: 1, rotated: 0, errors: 1 });
    const after = await prisma.dataBackup.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(after.data).toBe(altered);
    expect(after.chunkStreamId).toBeNull();
    expect(await prisma.dataBackupChunk.count()).toBe(0);
  });

  it("reports single-value copies by key id without reading them whole", async () => {
    const prisma = getPrismaClient();
    await prisma.dataBackup.create({
      data: {
        userId: TEST_USER_ID,
        type: "WEEKLY_AUTO",
        data: underKey("v1", BACKUP_JSON, true),
      },
    });
    const scan = await scanColumn(
      prisma as unknown as CorpusClient,
      column("DataBackup", "data"),
    );
    expect(scan).toMatchObject({ total: 1, byKeyId: { v1: 1 } });
  });

  it("rotates every piece of a chunked copy, which reads back once the old key is gone", async () => {
    const prisma = getPrismaClient();
    process.env.ENCRYPTION_ACTIVE_KEY_ID = "v1";
    _resetCryptoCacheForTests();
    const { id, chunks } = await storeBackupBlob(
      prisma,
      { userId: TEST_USER_ID, type: "WEEKLY_AUTO" },
      async (write) => {
        await write('{"rows":[');
        for (let i = 0; i < 20_000; i++) {
          await write(`${i ? "," : ""}{"i":${i},"r":${Math.random()}}`);
        }
        await write("]}");
      },
      { chunkBytes: 4 * 1024 },
    );
    expect(chunks).toBeGreaterThan(3);
    const expected = await readStoredBackup(prisma, id);

    process.env.ENCRYPTION_ACTIVE_KEY_ID = "v2";
    _resetCryptoCacheForTests();
    const client = {
      dataBackupChunk: prisma.dataBackupChunk,
    } as unknown as CorpusClient;
    const result = await rotateColumn(
      client,
      column("DataBackupChunk", "data"),
    );
    expect(result).toMatchObject({
      scanned: chunks,
      rotated: chunks,
      errors: 0,
    });
    const again = await rotateColumn(client, column("DataBackupChunk", "data"));
    expect(again.rotated).toBe(0);

    process.env.ENCRYPTION_KEYS = JSON.stringify({ v2: "2".repeat(64) });
    _resetCryptoCacheForTests();
    for (const piece of await prisma.dataBackupChunk.findMany()) {
      expect(extractKeyIdFromBytes(Buffer.from(piece.data))).toBe("v2");
    }
    expect(await readStoredBackup(prisma, id)).toBe(expected);
  });

  it("drops an unreadable idempotency row instead of failing the run", async () => {
    const prisma = getPrismaClient();
    const seed = async (key: string, body: string) =>
      prisma.idempotencyKey.create({
        data: {
          userId: TEST_USER_ID,
          key,
          method: "POST",
          path: "/api/measurements",
          responseStatus: 201,
          responseBody: body,
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      });
    const readable = await seed("k-readable", underKey("v1", '{"data":1}'));
    // A key id the deployment no longer configures: fail-closed on decrypt.
    const unreadable = await seed("k-unreadable", "v9.QUJDREVGR0hJSktM");

    const result = await rotateColumn(
      { idempotencyKey: prisma.idempotencyKey } as unknown as CorpusClient,
      column("IdempotencyKey", "responseBody"),
    );
    expect(result.rotated).toBe(1);
    expect(result.dropped).toBe(1);
    expect(result.errors).toBe(0);

    const kept = await prisma.idempotencyKey.findUnique({
      where: { id: readable.id },
    });
    expect(extractKeyId(kept!.responseBody)).toBe("v2");
    expect(
      await prisma.idempotencyKey.findUnique({ where: { id: unreadable.id } }),
    ).toBeNull();
  });

  it("keeps both columns in the registry the script and the job read", () => {
    const keys = ENCRYPTED_COLUMNS.map(encryptedColumnKey);
    expect(keys).toContain("DataBackup.data");
    expect(keys).toContain("DataBackupChunk.data");
    expect(keys).toContain("IdempotencyKey.responseBody");
  });
});
