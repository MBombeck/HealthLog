import { describe, it, expect, beforeEach } from "vitest";
import { Buffer } from "node:buffer";
import {
  encrypt,
  extractKeyId,
  getActiveKeyId,
  getConfiguredKeyIds,
  _resetCryptoCacheForTests,
} from "@/lib/crypto";
import {
  scanCorpus,
  rotateCorpus,
  LEGACY_BUCKET,
  type CorpusClient,
} from "@/lib/crypto/encryption-corpus";
import { ENCRYPTED_COLUMNS } from "@/lib/crypto/encrypted-columns";

const KEY_V1 =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const KEY_V2 =
  "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

function delegateKey(model: string): string {
  return model.charAt(0).toLowerCase() + model.slice(1);
}

interface Row {
  id: string;
  [field: string]: unknown;
}

/**
 * In-memory fake Prisma client covering every model in the registry, backed by
 * a per-model row store. Only the models we seed hold rows; the rest are empty.
 */
function makeClient(seed: Record<string, Row[]>): {
  client: CorpusClient;
  store: Record<string, Row[]>;
} {
  const store: Record<string, Row[]> = {};
  const client: CorpusClient = {};
  for (const col of ENCRYPTED_COLUMNS) {
    const key = delegateKey(col.model);
    if (!store[col.model]) store[col.model] = seed[col.model] ?? [];
    if (client[key]) continue;
    const model = col.model;
    client[key] = {
      // `take` / `id > last` are honoured so the batched-column walk
      // terminates here the way it does against Postgres.
      findMany: async ({ select, take, where }) => {
        const fields = Object.keys(select);
        let rows = [...store[model]].sort((a, b) =>
          String(a.id).localeCompare(String(b.id)),
        );
        const after = where?.id?.gt;
        if (after !== undefined)
          rows = rows.filter((r) => String(r.id) > after);
        if (take !== undefined) rows = rows.slice(0, take);
        return rows.map((row) => {
          const out: Record<string, unknown> = {};
          for (const f of fields) out[f] = row[f];
          return out;
        });
      },
      update: async ({ where, data }) => {
        const row = store[model].find((r) => r.id === where.id);
        if (row) Object.assign(row, data);
        return row;
      },
      delete: async ({ where }) => {
        const at = store[model].findIndex((r) => r.id === where.id);
        return at < 0 ? null : store[model].splice(at, 1)[0];
      },
    };
  }
  return { client, store };
}

function activeUnder(keyId: string, plaintext: string): string {
  // Encrypt while a given key id is active, then restore v2 as active.
  process.env.ENCRYPTION_ACTIVE_KEY_ID = keyId;
  _resetCryptoCacheForTests();
  const ct = encrypt(plaintext);
  process.env.ENCRYPTION_ACTIVE_KEY_ID = "v2";
  _resetCryptoCacheForTests();
  return ct;
}

describe("encryption-corpus scan + rotate", () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEYS = JSON.stringify({ v1: KEY_V1, v2: KEY_V2 });
    process.env.ENCRYPTION_ACTIVE_KEY_ID = "v2";
    delete process.env.ENCRYPTION_KEY;
    _resetCryptoCacheForTests();
  });

  it("buckets rows by key id (string + bytes columns)", async () => {
    const stringCt = activeUnder("v1", "token-under-v1");
    const stringActive = encrypt("token-under-v2");
    const bytesCt = Buffer.from(activeUnder("v1", "note-under-v1"), "utf8");

    const { client } = makeClient({
      User: [
        { id: "u1", codexAccessTokenEncrypted: stringCt },
        { id: "u2", codexAccessTokenEncrypted: stringActive },
      ],
      MoodEntry: [{ id: "m1", noteEncrypted: bytesCt }],
    });

    const scan = await scanCorpus(client);
    expect(scan.activeKeyId).toBe("v2");

    const userCol = scan.columns.find(
      (c) => c.model === "User" && c.field === "codexAccessTokenEncrypted",
    )!;
    expect(userCol.total).toBe(2);
    expect(userCol.byKeyId.v1).toBe(1);
    expect(userCol.byKeyId.v2).toBe(1);

    const moodCol = scan.columns.find(
      (c) => c.model === "MoodEntry" && c.field === "noteEncrypted",
    )!;
    expect(moodCol.total).toBe(1);
    expect(moodCol.byKeyId.v1).toBe(1);

    // 3 rows total, 1 already on the active key.
    expect(scan.totalRows).toBe(3);
    expect(scan.activeRows).toBe(1);
    expect(scan.staleRows).toBe(2);
    expect(scan.rotationComplete).toBe(false);
  });

  it("rotates stale rows to the active key and is idempotent", async () => {
    const { client, store } = makeClient({
      User: [{ id: "u1", codexAccessTokenEncrypted: activeUnder("v1", "x") }],
      MoodEntry: [
        {
          id: "m1",
          noteEncrypted: Buffer.from(activeUnder("v1", "y"), "utf8"),
        },
      ],
    });

    const first = await rotateCorpus(client);
    expect(first.totalRotated).toBe(2);
    expect(first.totalErrors).toBe(0);

    // ACTIVE-KEY-ONLY: every row now carries the active key id.
    expect(
      extractKeyId(store.User[0].codexAccessTokenEncrypted as string),
    ).toBe(getActiveKeyId());
    expect(
      extractKeyId(
        Buffer.from(store.MoodEntry[0].noteEncrypted as Uint8Array).toString(
          "utf8",
        ),
      ),
    ).toBe(getActiveKeyId());

    // IDEMPOTENT: a second pass rotates nothing.
    const second = await rotateCorpus(client);
    expect(second.totalRotated).toBe(0);

    const scan = await scanCorpus(client);
    expect(scan.rotationComplete).toBe(true);
    expect(scan.staleRows).toBe(0);
  });

  it("never adds or drops a key during rotation", async () => {
    const before = getConfiguredKeyIds().sort();
    const { client } = makeClient({
      User: [{ id: "u1", codexAccessTokenEncrypted: activeUnder("v1", "x") }],
    });
    await rotateCorpus(client);
    const after = getConfiguredKeyIds().sort();
    expect(after).toEqual(before);
    expect(after).toEqual(["v1", "v2"]);
  });

  it("fails closed on a row under a no-longer-configured key (no data loss)", async () => {
    // A ciphertext whose key id ('v9') is not in ENCRYPTION_KEYS. Decrypt
    // throws -> counted as an error, the row is left untouched.
    const orphan = "v9." + Buffer.from("garbage").toString("base64");
    const { client, store } = makeClient({
      User: [{ id: "u1", codexAccessTokenEncrypted: orphan }],
    });

    const result = await rotateCorpus(client);
    expect(result.totalErrors).toBe(1);
    expect(result.totalRotated).toBe(0);
    // Row preserved exactly, not dropped or blanked.
    expect(store.User[0].codexAccessTokenEncrypted).toBe(orphan);
  });

  it("treats legacy (unversioned) ciphertext as stale and buckets it", async () => {
    // Legacy bare-base64 row written by the old single-key path.
    process.env.ENCRYPTION_KEYS = "";
    process.env.ENCRYPTION_ACTIVE_KEY_ID = "";
    process.env.ENCRYPTION_KEY = KEY_V1;
    _resetCryptoCacheForTests();
    const legacy = encrypt("legacy-secret").replace(/^v1\./, ""); // strip prefix

    process.env.ENCRYPTION_KEYS = JSON.stringify({ v1: KEY_V1, v2: KEY_V2 });
    process.env.ENCRYPTION_ACTIVE_KEY_ID = "v2";
    delete process.env.ENCRYPTION_KEY;
    _resetCryptoCacheForTests();

    const { client } = makeClient({
      User: [{ id: "u1", codexAccessTokenEncrypted: legacy }],
    });
    const scan = await scanCorpus(client);
    const col = scan.columns.find(
      (c) => c.model === "User" && c.field === "codexAccessTokenEncrypted",
    )!;
    expect(col.legacy).toBe(1);
    expect(col.byKeyId[LEGACY_BUCKET]).toBe(1);
  });

  it("reads every column in bounded pages and counts only rows that hold ciphertext (#1031)", async () => {
    // A notes column is read for every row of its table, 1.25 million on a
    // large account, and was read in one findMany. 12 000 measurements, one
    // in ten with a note written under the old key.
    const measurements: Row[] = Array.from({ length: 12_000 }, (_, i) => ({
      id: `m-${String(i).padStart(5, "0")}`,
      notesEncrypted:
        i % 10 === 0
          ? new Uint8Array(Buffer.from(activeUnder("v1", `note ${i}`), "utf8"))
          : null,
    }));
    const { client } = makeClient({ Measurement: measurements });
    const takes: Array<number | undefined> = [];
    const measurement = client.measurement!;
    const findMany = measurement.findMany;
    measurement.findMany = (args) => {
      takes.push(args.take);
      return findMany(args);
    };

    const scan = await scanCorpus(client);
    const col = scan.columns.find(
      (c) => c.model === "Measurement" && c.field === "notesEncrypted",
    )!;
    expect(col.total).toBe(1_200);
    expect(col.byKeyId.v1).toBe(1_200);

    const rotation = await rotateCorpus(client);
    const result = rotation.results.find(
      (r) => r.model === "Measurement" && r.field === "notesEncrypted",
    )!;
    expect(result.scanned).toBe(1_200);
    expect(result.rotated).toBe(1_200);

    expect(takes.length).toBeGreaterThan(2);
    for (const take of takes) {
      expect(take).toBeDefined();
      expect(take!).toBeLessThanOrEqual(5_000);
    }
  });
});
