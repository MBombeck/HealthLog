import { describe, it, expect, beforeEach } from "vitest";
import { Buffer } from "node:buffer";
import {
  encrypt,
  encryptBytes,
  extractKeyIdFromBytes,
  getActiveKeyId,
  _resetCryptoCacheForTests,
} from "@/lib/crypto";
import {
  rotateColumn,
  scanColumn,
  BLOB_ROTATION_BATCH_SIZE,
  type CorpusClient,
} from "@/lib/crypto/encryption-corpus";
import type { EncryptedColumn } from "@/lib/crypto/encrypted-columns";

/**
 * Codec-dispatched blob rotation (the document vault's `contentEncrypted`):
 * the walk is id-cursor paginated with a bounded batch size — never an
 * unbounded blob `findMany` — re-encrypts each row under its OWN codec,
 * fails closed per row on an unknown codec, and resumes cleanly after an
 * interrupted run because already-active rows are skipped.
 */

const KEY_V1 =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const KEY_V2 =
  "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

const DOC_COLUMN: EncryptedColumn = {
  model: "InboundDocument",
  field: "contentEncrypted",
  kind: "bytes",
  codecField: "contentCodec",
};

interface DocRow {
  id: string;
  contentEncrypted: Uint8Array;
  contentCodec: string;
}

interface FindManyArgs {
  select: Record<string, true>;
  orderBy?: Record<string, "asc" | "desc">;
  take?: number;
  where?: Record<string, { gt: string }>;
}

/**
 * Pagination-honouring fake delegate: applies orderBy(id) + `id > last` +
 * take exactly like the keyset pagination the walk sends, and records every findMany
 * call so the test can assert the batch boundedness.
 */
function makeDocClient(rows: DocRow[]): {
  client: CorpusClient;
  store: DocRow[];
  findManyCalls: FindManyArgs[];
  failUpdatesFor: Set<string>;
} {
  const store = [...rows];
  const findManyCalls: FindManyArgs[] = [];
  const failUpdatesFor = new Set<string>();
  const client = {
    inboundDocument: {
      findMany: async (args: FindManyArgs) => {
        findManyCalls.push(args);
        let list = [...store].sort((a, b) => a.id.localeCompare(b.id));
        const after = args.where?.id?.gt;
        if (after !== undefined) list = list.filter((r) => r.id > after);
        if (args.take !== undefined) list = list.slice(0, args.take);
        return list.map((row) => {
          const out: Record<string, unknown> = {};
          for (const f of Object.keys(args.select)) {
            out[f] = row[f as keyof DocRow];
          }
          return out;
        });
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        if (failUpdatesFor.has(where.id)) {
          throw new Error("simulated interruption");
        }
        const row = store.find((r) => r.id === where.id);
        if (row) Object.assign(row, data);
        return row;
      },
    },
  } as unknown as CorpusClient;
  return { client, store, findManyCalls, failUpdatesFor };
}

function binaryUnder(keyId: "v1" | "v2", plaintext: Buffer): Uint8Array {
  process.env.ENCRYPTION_ACTIVE_KEY_ID = keyId;
  _resetCryptoCacheForTests();
  const out = encryptBytes(plaintext);
  process.env.ENCRYPTION_ACTIVE_KEY_ID = "v2";
  _resetCryptoCacheForTests();
  return new Uint8Array(out);
}

function legacyUnder(keyId: "v1" | "v2", plaintext: string): Uint8Array {
  process.env.ENCRYPTION_ACTIVE_KEY_ID = keyId;
  _resetCryptoCacheForTests();
  const ct = encrypt(Buffer.from(plaintext).toString("base64"));
  process.env.ENCRYPTION_ACTIVE_KEY_ID = "v2";
  _resetCryptoCacheForTests();
  return new Uint8Array(Buffer.from(ct, "utf8"));
}

function pad(i: number): string {
  return `doc-${String(i).padStart(5, "0")}`;
}

beforeEach(() => {
  process.env.ENCRYPTION_KEYS = JSON.stringify({ v1: KEY_V1, v2: KEY_V2 });
  process.env.ENCRYPTION_ACTIVE_KEY_ID = "v2";
  delete process.env.ENCRYPTION_KEY;
  _resetCryptoCacheForTests();
});

describe("codec-dispatched blob rotation (bounded batches)", () => {
  it("walks a 500-row corpus in bounded id-cursor batches and rotates both codecs", async () => {
    const rows: DocRow[] = [];
    // 200 binary2 under the stale v1, 150 legacy base64v1 under v1,
    // 100 binary2 already on v2 (skipped), 50 legacy already on v2 (skipped).
    for (let i = 0; i < 200; i++) {
      rows.push({
        id: pad(i),
        contentEncrypted: binaryUnder("v1", Buffer.from(`bin-${i}`)),
        contentCodec: "binary2",
      });
    }
    for (let i = 200; i < 350; i++) {
      rows.push({
        id: pad(i),
        contentEncrypted: legacyUnder("v1", `legacy-${i}`),
        contentCodec: "base64v1",
      });
    }
    for (let i = 350; i < 450; i++) {
      rows.push({
        id: pad(i),
        contentEncrypted: binaryUnder("v2", Buffer.from(`bin-${i}`)),
        contentCodec: "binary2",
      });
    }
    for (let i = 450; i < 500; i++) {
      rows.push({
        id: pad(i),
        contentEncrypted: legacyUnder("v2", `legacy-${i}`),
        contentCodec: "base64v1",
      });
    }

    const { client, store, findManyCalls } = makeDocClient(rows);
    const result = await rotateColumn(client, DOC_COLUMN);

    expect(result.scanned).toBe(500);
    expect(result.rotated).toBe(350);
    expect(result.errors).toBe(0);

    // BOUNDED: every page requested at most the batch size, and the walk
    // needed ceil(500 / batch) full pages (+1 terminating empty page, since
    // 500 is an exact multiple) — never one unbounded findMany.
    expect(findManyCalls.length).toBe(
      Math.ceil(500 / BLOB_ROTATION_BATCH_SIZE) + 1,
    );
    for (const call of findManyCalls) {
      expect(call.take).toBe(BLOB_ROTATION_BATCH_SIZE);
      expect(call.orderBy).toEqual({ id: "asc" });
    }
    // Cursor advanced between pages.
    expect(findManyCalls[0].where).toBeUndefined();
    expect(findManyCalls[1].where).toEqual({ id: { gt: pad(24) } });

    // Every row now reads under the active key, each in its OWN codec.
    for (const row of store) {
      if (row.contentCodec === "binary2") {
        expect(extractKeyIdFromBytes(Buffer.from(row.contentEncrypted))).toBe(
          getActiveKeyId(),
        );
      } else {
        expect(
          Buffer.from(row.contentEncrypted).toString("utf8").startsWith("v2."),
        ).toBe(true);
      }
    }

    // IDEMPOTENT: the second pass rotates nothing.
    const second = await rotateColumn(client, DOC_COLUMN);
    expect(second.rotated).toBe(0);
    expect(second.errors).toBe(0);
  });

  it("resumes after an interrupted run (already-rotated rows are skipped)", async () => {
    const rows: DocRow[] = [];
    for (let i = 0; i < 60; i++) {
      rows.push({
        id: pad(i),
        contentEncrypted: binaryUnder("v1", Buffer.from(`bin-${i}`)),
        contentCodec: "binary2",
      });
    }
    const { client, failUpdatesFor } = makeDocClient(rows);

    // First run: the last 20 updates fail (simulated interruption) — they
    // are counted, never dropped.
    for (let i = 40; i < 60; i++) failUpdatesFor.add(pad(i));
    const first = await rotateColumn(client, DOC_COLUMN);
    expect(first.rotated).toBe(40);
    expect(first.errors).toBe(20);

    // Second run with the interruption cleared: exactly the remainder
    // rotates — the 40 already-active rows are skipped.
    failUpdatesFor.clear();
    const second = await rotateColumn(client, DOC_COLUMN);
    expect(second.rotated).toBe(20);
    expect(second.errors).toBe(0);
  });

  it("fails closed per row on an unknown codec and leaves the row untouched", async () => {
    const strange = new Uint8Array(Buffer.from("???strange???"));
    const { client, store } = makeDocClient([
      {
        id: pad(0),
        contentEncrypted: binaryUnder("v1", Buffer.from("fine")),
        contentCodec: "binary2",
      },
      { id: pad(1), contentEncrypted: strange, contentCodec: "codec9" },
    ]);

    const result = await rotateColumn(client, DOC_COLUMN);
    expect(result.rotated).toBe(1);
    expect(result.errors).toBe(1);
    expect(store.find((r) => r.id === pad(1))!.contentEncrypted).toBe(strange);
  });

  it("scanColumn buckets blob rows per codec-aware key id in bounded batches", async () => {
    const { client, findManyCalls } = makeDocClient([
      {
        id: pad(0),
        contentEncrypted: binaryUnder("v1", Buffer.from("a")),
        contentCodec: "binary2",
      },
      {
        id: pad(1),
        contentEncrypted: legacyUnder("v1", "b"),
        contentCodec: "base64v1",
      },
      {
        id: pad(2),
        contentEncrypted: binaryUnder("v2", Buffer.from("c")),
        contentCodec: "binary2",
      },
    ]);
    const scan = await scanColumn(client, DOC_COLUMN);
    expect(scan.total).toBe(3);
    expect(scan.byKeyId.v1).toBe(2);
    expect(scan.byKeyId.v2).toBe(1);
    expect(scan.legacy).toBe(0);
    for (const call of findManyCalls) {
      expect(call.take).toBe(BLOB_ROTATION_BATCH_SIZE);
    }
  });
});
