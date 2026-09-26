/**
 * The stored-backup envelope: compress, then encrypt, then store in pieces.
 *
 * Compressing before the cipher is what makes the tail of the pipeline cheap:
 * health JSON is extremely repetitive, so everything downstream of the gzip
 * shrinks by an order of magnitude. Every form a copy was ever stored in has to
 * stay readable: plain `encrypt(json)`, the `HLZ1:` gzip form, and the single
 * `~hlgcm1.` stream v1.39.1 wrote. From v1.39.2 a copy is written as sealed
 * pieces (`packBackupChunks`), and the one limit on its size is a storage
 * setting, not a share of the heap (#1031).
 */
process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { randomBytes } from "node:crypto";
import { gunzipSync } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

import { encrypt } from "@/lib/crypto";
import {
  legacyStreamedBlob,
  legacyStreamedBlobFrom,
} from "@/__tests__/helpers/legacy-backup-blob";
import {
  BackupBlobTooLargeError,
  defaultBackupStoreLimit,
  packBackupBlob,
  packBackupChunks,
  unpackBackupBlob,
} from "../backup-blob";
import { BACKUP_CHUNK_BYTES, openBackupChunk } from "../backup-chunks";

const STREAM = "0123456789abcdef0123456789abcdef";

/** Pack a whole string in small pieces; answer the sealed pieces. */
async function packChunked(
  json: string,
  pieceSize = 4_096,
  maxBytes?: number,
): Promise<Buffer[]> {
  const sealed: Buffer[] = [];
  await packBackupChunks(
    async (piece, seq) => {
      expect(seq).toBe(sealed.length);
      sealed.push(piece);
    },
    STREAM,
    async (write) => {
      for (let at = 0; at < json.length; at += pieceSize) {
        await write(json.slice(at, at + pieceSize));
      }
    },
    maxBytes === undefined ? {} : { maxBytes },
  );
  return sealed;
}

/** Open every piece in order and gunzip the result. */
function readChunked(sealed: Buffer[]): string {
  const gz = sealed.map((piece, seq) =>
    openBackupChunk(piece, {
      streamId: STREAM,
      seq,
      last: seq === sealed.length - 1,
    }),
  );
  return gunzipSync(Buffer.concat(gz)).toString("utf8");
}

/** A record-shaped string: many rows, few distinct keys. */
function sampleJson(rows: number): string {
  return JSON.stringify({
    schemaVersion: "2",
    measurements: Array.from({ length: rows }, (_, i) => ({
      id: `measurement-${i}`,
      type: "PULSE",
      value: 60 + (i % 30),
      unit: "bpm",
      measuredAt: new Date(Date.UTC(2026, 0, 1, 0, i % 60)).toISOString(),
      source: "APPLE_HEALTH",
      deletedAt: null,
    })),
  });
}

describe("backup blob envelope", () => {
  it("round-trips the exact JSON it was handed", () => {
    const json = sampleJson(200);
    expect(unpackBackupBlob(packBackupBlob(json))).toBe(json);
  });

  it("stores a record-shaped payload far smaller than the plaintext", () => {
    const json = sampleJson(5_000);
    const packed = packBackupBlob(json);
    // The old envelope was 1.33× the JSON. Anything near that means the
    // compression leg is not running.
    expect(packed.length).toBeLessThan(json.length / 4);
  });

  it("still reads a row written before the envelope existed", () => {
    const json = sampleJson(10);
    expect(unpackBackupBlob(encrypt(json))).toBe(json);
  });

  it("fails closed on a corrupt blob rather than returning junk", () => {
    const packed = packBackupBlob(sampleJson(10));
    const mangled = `${packed.slice(0, -8)}AAAAAAAA`;
    expect(() => unpackBackupBlob(mangled)).toThrow();
  });

  it("still reads the single stream v1.39.1 stored", () => {
    const json = sampleJson(2_000);
    expect(unpackBackupBlob(legacyStreamedBlob(json))).toBe(json);
  });

  it("keeps the three single-value shapes readable side by side", async () => {
    // An operator's newest usable copy may predate the pieces, and the
    // restore has to work for exactly that person. Plain, compressed and
    // streamed all decode through the one entry point.
    const json = sampleJson(50);
    expect(unpackBackupBlob(encrypt(json))).toBe(json);
    expect(unpackBackupBlob(packBackupBlob(json))).toBe(json);
    expect(
      unpackBackupBlob(
        await legacyStreamedBlobFrom(async (write) => {
          await write(json);
        }),
      ),
    ).toBe(json);
  });

  it("refuses a v1.39.1 stream whose authentication tag was altered", () => {
    const streamed = legacyStreamedBlob(sampleJson(20));
    // The tag is the last 16 bytes of the payload, so the tail of the base64.
    const mangled = `${streamed.slice(0, -6)}${streamed.slice(-6) === "AAAAAA" ? "BBBBBB" : "AAAAAA"}`;
    expect(() => unpackBackupBlob(mangled)).toThrow();
  });
});

describe("the copy in sealed pieces", () => {
  const savedLimit = process.env.BACKUP_MAX_STORED_MB;
  afterEach(() => {
    if (savedLimit === undefined) delete process.env.BACKUP_MAX_STORED_MB;
    else process.env.BACKUP_MAX_STORED_MB = savedLimit;
  });

  /** JSON that gzip cannot shrink much, so the copy spans several pieces. */
  function incompressibleJson(bytes: number): string {
    return JSON.stringify({
      noise: randomBytes(Math.ceil((bytes * 3) / 4)).toString("base64"),
    });
  }

  it("reads back the exact JSON, whatever the producer's piece size", async () => {
    const json = sampleJson(20);
    for (const pieceSize of [1, 3, 64, 1_001, json.length]) {
      expect(readChunked(await packChunked(json, pieceSize))).toBe(json);
    }
  });

  it("compresses: a record-shaped copy is far smaller than its JSON", async () => {
    const json = sampleJson(5_000);
    const stored = (await packChunked(json)).reduce(
      (sum, piece) => sum + piece.byteLength,
      0,
    );
    expect(stored).toBeLessThan(json.length / 4);
  });

  it("hands on bounded pieces while the producer is still writing", async () => {
    const json = incompressibleJson(5 * BACKUP_CHUNK_BYTES);
    let producing = false;
    let whileProducing = 0;
    const sealed: Buffer[] = [];
    await packBackupChunks(
      async (piece) => {
        sealed.push(piece);
        if (producing) whileProducing += 1;
      },
      STREAM,
      async (write) => {
        producing = true;
        for (let at = 0; at < json.length; at += 64 * 1024) {
          await write(json.slice(at, at + 64 * 1024));
        }
        producing = false;
      },
    );
    expect(sealed.length).toBeGreaterThan(3);
    expect(whileProducing).toBeGreaterThan(1);
    // One piece's worth plus one gzip flush of slack, plus the seal.
    for (const piece of sealed) {
      expect(piece.byteLength).toBeLessThan(BACKUP_CHUNK_BYTES + 256 * 1024);
    }
    expect(readChunked(sealed)).toBe(json);
  });

  it("always ends with a piece marked as the last, even an empty one", async () => {
    const sealed = await packChunked("{}");
    expect(sealed).toHaveLength(1);
    expect(readChunked(sealed)).toBe("{}");
  });

  it("propagates a producer failure instead of sealing a truncated copy", async () => {
    const sealed: Buffer[] = [];
    await expect(
      packBackupChunks(
        async (piece) => {
          sealed.push(piece);
        },
        STREAM,
        async (write) => {
          await write('{"measurements":[');
          throw new Error("row source failed");
        },
      ),
    ).rejects.toThrow("row source failed");
    // Nothing was marked as the last piece of a complete copy.
    expect(sealed).toHaveLength(0);
  });

  it("stops at the stored-copy limit with a message an operator can act on", async () => {
    const err = await packChunked(sampleJson(5_000), 4_096, 4_096).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(BackupBlobTooLargeError);
    const failure = err as BackupBlobTooLargeError;
    expect(failure.limitBytes).toBe(4_096);
    expect(failure.bytes).toBeGreaterThan(4_096);
    expect(failure.message).toContain("of encrypted backup for one account");
    expect(failure.message).toContain("BACKUP_MAX_STORED_MB");
    expect(failure.message).toContain("previous copy is unchanged");
    // Memory is not the answer any more, so the message must not send the
    // operator after it.
    expect(failure.message).not.toMatch(/heap|memory|max-old-space-size/i);
  });

  it("sets the default limit by storage, not by this process's heap", () => {
    delete process.env.BACKUP_MAX_STORED_MB;
    expect(defaultBackupStoreLimit()).toBe(2048 * 1024 * 1024);
    process.env.BACKUP_MAX_STORED_MB = "300";
    expect(defaultBackupStoreLimit()).toBe(300 * 1024 * 1024);
    // A value that is not a positive number falls back to the default
    // rather than to zero, which would refuse every backup.
    for (const junk of ["", "0", "-5", "lots"]) {
      process.env.BACKUP_MAX_STORED_MB = junk;
      expect(defaultBackupStoreLimit()).toBe(2048 * 1024 * 1024);
    }
  });
});
