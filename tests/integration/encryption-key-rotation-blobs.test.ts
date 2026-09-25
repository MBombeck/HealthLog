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
 * Both stored envelopes are seeded on purpose. A row written before
 * `packBackupBlob` existed is `encrypt(json)`; one written after is the
 * `HLZ1:`-prefixed gzip form. Rotation re-seals the ciphertext without ever
 * looking at the plaintext, so both come back byte-identical — and so will
 * whatever envelope a later writer introduces.
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
  type CorpusClient,
} from "@/lib/crypto/encryption-corpus";
import { packBackupBlob, unpackBackupBlob } from "@/lib/export/backup-blob";
import { extractKeyIdFromBytes } from "@/lib/crypto";
import { storeBackupBlob } from "@/lib/export/store-backup-blob";
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
  it("rotates DataBackup.data in both stored envelopes and keeps it readable", async () => {
    const prisma = getPrismaClient();
    const gzipped = await prisma.dataBackup.create({
      data: {
        userId: TEST_USER_ID,
        type: "WEEKLY_AUTO",
        data: underKey("v1", BACKUP_JSON, true),
      },
    });
    // The pre-envelope shape: `encrypt(json)` with no `HLZ1:` marker.
    const plainEnvelope = await prisma.dataBackup.create({
      data: {
        userId: TEST_USER_ID,
        type: "MANUAL_UPLOAD_1",
        data: underKey("v1", BACKUP_JSON),
      },
    });

    const result = await rotateColumn(
      { dataBackup: prisma.dataBackup } as unknown as CorpusClient,
      column("DataBackup", "data"),
    );
    expect(result.scanned).toBe(2);
    expect(result.rotated).toBe(2);
    expect(result.errors).toBe(0);
    expect(result.dropped).toBe(0);

    for (const id of [gzipped.id, plainEnvelope.id]) {
      const row = await prisma.dataBackup.findUniqueOrThrow({ where: { id } });
      expect(extractKeyId(row.data!)).toBe("v2");
      expect(unpackBackupBlob(row.data!)).toBe(BACKUP_JSON);
    }

    // Idempotent: a second pass finds nothing left to do.
    const again = await rotateColumn(
      { dataBackup: prisma.dataBackup } as unknown as CorpusClient,
      column("DataBackup", "data"),
    );
    expect(again.scanned).toBe(2);
    expect(again.rotated).toBe(0);
  });

  it("survives dropping the retired key once rotation has run", async () => {
    const prisma = getPrismaClient();
    const backup = await prisma.dataBackup.create({
      data: {
        userId: TEST_USER_ID,
        type: "WEEKLY_AUTO",
        data: underKey("v1", BACKUP_JSON, true),
      },
    });
    await rotateColumn(
      { dataBackup: prisma.dataBackup } as unknown as CorpusClient,
      column("DataBackup", "data"),
    );

    // What the runbook tells the operator to do next: retire v1 entirely.
    process.env.ENCRYPTION_KEYS = JSON.stringify({ v2: "2".repeat(64) });
    _resetCryptoCacheForTests();

    const row = await prisma.dataBackup.findUniqueOrThrow({
      where: { id: backup.id },
    });
    expect(unpackBackupBlob(row.data!)).toBe(BACKUP_JSON);
  });

  it("rotates the single stream v1.39.1 stored, and it stays readable", async () => {
    // The `~hlgcm1.` form carries its key id behind a marker the string
    // codec's parser does not read, so the walk used to file it as legacy
    // and fail to decrypt it: the one copy form every v1.39.x host had was
    // counted as an error on every rotation.
    const prisma = getPrismaClient();
    const previous = process.env.ENCRYPTION_ACTIVE_KEY_ID;
    process.env.ENCRYPTION_ACTIVE_KEY_ID = "v1";
    _resetCryptoCacheForTests();
    const stored = legacyStreamedBlob(BACKUP_JSON);
    process.env.ENCRYPTION_ACTIVE_KEY_ID = previous;
    _resetCryptoCacheForTests();
    const row = await prisma.dataBackup.create({
      data: { userId: TEST_USER_ID, type: "WEEKLY_AUTO", data: stored },
    });

    const result = await rotateColumn(
      { dataBackup: prisma.dataBackup } as unknown as CorpusClient,
      column("DataBackup", "data"),
    );
    expect(result).toMatchObject({ scanned: 1, rotated: 1, errors: 0 });

    process.env.ENCRYPTION_KEYS = JSON.stringify({ v2: "2".repeat(64) });
    _resetCryptoCacheForTests();
    const after = await prisma.dataBackup.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(after.data!.startsWith("~hlgcm1.v2.")).toBe(true);
    expect(unpackBackupBlob(after.data!)).toBe(BACKUP_JSON);
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
