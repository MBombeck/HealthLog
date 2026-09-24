/**
 * The stored-backup envelope: compress, then encrypt.
 *
 * The weekly worker used to hand `encrypt(JSON.stringify(payload))` straight to
 * Postgres. For an account with a few hundred thousand measurements that means
 * the object graph, the JSON string, the base64 ciphertext (1.33× the JSON) and
 * the copy the database driver makes of it all alive at once — well over a
 * gigabyte for a record whose JSON is a few hundred megabytes. The run died of
 * memory, not of slow SQL.
 *
 * Compressing before the cipher is what makes the tail of that pipeline cheap:
 * health JSON is extremely repetitive, so everything downstream of the gzip
 * shrinks by an order of magnitude. The envelope has to stay readable both
 * ways — rows written before this change are plain `encrypt(json)` and must
 * keep restoring.
 */
process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { randomBytes } from "node:crypto";
import v8 from "node:v8";

import { describe, expect, it } from "vitest";

import { encrypt } from "@/lib/crypto";
import {
  BackupBlobTooLargeError,
  defaultBackupBlobLimit,
  packBackupBlob,
  packBackupBlobInto,
  packBackupBlobStreaming,
  unpackBackupBlob,
} from "../backup-blob";

/** Pack a whole string through the streaming writer, in small pieces. */
async function packStreamed(json: string, pieceSize = 4_096): Promise<string> {
  return packBackupBlobStreaming(async (write) => {
    for (let at = 0; at < json.length; at += pieceSize) {
      await write(json.slice(at, at + pieceSize));
    }
  });
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

  it("reads back a streamed blob byte for byte", async () => {
    const json = sampleJson(2_000);
    expect(unpackBackupBlob(await packStreamed(json))).toBe(json);
  });

  it("is indifferent to where the producer's pieces fall", async () => {
    // Base64 encodes three bytes at a time, so a writer that carries its
    // sub-group remainder across chunks wrongly still round-trips at some
    // piece sizes and corrupts at others. Cover every residue class.
    // Small on purpose: a one-byte piece size means one write per character,
    // and the point of the case is the residue class, not the volume.
    const json = sampleJson(20);
    for (const pieceSize of [1, 2, 3, 7, 64, 1_000, 1_001, json.length]) {
      expect(unpackBackupBlob(await packStreamed(json, pieceSize))).toBe(json);
    }
  });

  it("compresses the streamed form as hard as the buffered one", async () => {
    const json = sampleJson(5_000);
    expect((await packStreamed(json)).length).toBeLessThan(json.length / 4);
  });

  it("keeps the three stored shapes readable side by side", async () => {
    // An operator's newest usable copy may predate either change, and the
    // restore has to work for exactly that person. Plain, compressed and
    // streamed all decode through the one entry point.
    const json = sampleJson(50);
    expect(unpackBackupBlob(encrypt(json))).toBe(json);
    expect(unpackBackupBlob(packBackupBlob(json))).toBe(json);
    expect(unpackBackupBlob(await packStreamed(json))).toBe(json);
  });

  it("cannot be confused for a legacy blob", async () => {
    // The marker starts with a tilde, which is in neither the key-id charset
    // nor the base64 alphabet, so no value the older writers can produce
    // begins with it and the two families never have to be sniffed apart.
    const streamed = await packStreamed(sampleJson(10));
    expect(streamed.startsWith("~")).toBe(true);
    expect(packBackupBlob(sampleJson(10)).startsWith("~")).toBe(false);
    expect(encrypt("x").startsWith("~")).toBe(false);
  });

  it("refuses a streamed blob whose authentication tag was altered", async () => {
    const streamed = await packStreamed(sampleJson(20));
    // The tag is the last 16 bytes of the payload, so the tail of the base64.
    const mangled = `${streamed.slice(0, -6)}${streamed.slice(-6) === "AAAAAA" ? "BBBBBB" : "AAAAAA"}`;
    expect(() => unpackBackupBlob(mangled)).toThrow();
  });

  it("propagates a producer failure instead of storing a truncated blob", async () => {
    await expect(
      packBackupBlobStreaming(async (write) => {
        await write('{"measurements":[');
        throw new Error("row source failed");
      }),
    ).rejects.toThrow("row source failed");
  });

  it("stops the account whose stored copy would not fit this process", async () => {
    // The stored blob is the one copy the pipeline has to hold whole, so it is
    // the one thing here that grows without bound as a record grows. 4 KB is
    // an absurd limit; the point is that the writer counts what it produced
    // and stops on that, not on how full the heap happened to be.
    const err = await packBackupBlobStreaming(
      async (write) => {
        await write(sampleJson(5_000));
      },
      { maxBytes: 4_096 },
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BackupBlobTooLargeError);
    const failure = err as BackupBlobTooLargeError;
    expect(failure.limitBytes).toBe(4_096);
    expect(failure.bytes).toBeGreaterThan(4_096);
    // The message has to describe what was measured. It says how much
    // ciphertext this account produced and what it may occupy — not how full
    // the process's heap was, which is what the check this replaced reported.
    expect(failure.message).toContain("of encrypted backup for one account");
    expect(failure.message).toContain("over the 4 KB");
    // The check this replaced reported "aborted at N MB of heap", which was a
    // reading of the whole process and said nothing about the account.
    expect(failure.message).not.toContain("of heap");
  });

  it("does not stop a record that fits, however dirty the heap is", async () => {
    // Collectable garbage past 419 MB: 80 % of the 524 MB V8 limit a 1 GB
    // container gets, which is the exact budget that aborted all four accounts
    // on the live instance — the smallest of them a 1.2 MB demo record.
    const CONTAINER_BUDGET = Math.floor(524 * 1024 * 1024 * 0.8);
    // Capped against this process's own limit, so a runner started with a
    // smaller heap measures a backup rather than an out-of-memory abort.
    const target = Math.min(
      CONTAINER_BUDGET + 8 * 1024 * 1024,
      Math.floor(v8.getHeapStatistics().heap_size_limit * 0.6),
    );
    let garbage: unknown[] = [];
    for (
      let round = 0;
      round < 2_000 && process.memoryUsage().heapUsed < target;
      round++
    ) {
      const chunk = new Array(30_000);
      for (let at = 0; at < 30_000; at++) chunk[at] = { k: round * at };
      garbage.push(chunk);
    }
    const dirty = process.memoryUsage().heapUsed;
    garbage = [];
    void garbage;

    const blob = await packStreamed(sampleJson(200));
    expect(unpackBackupBlob(blob)).toBe(sampleJson(200));
    // Not a vacuous pass: the heap really was carrying the pile it aimed at
    // — a 1 GB container's whole budget where the runner has room for it —
    // when the backup ran.
    expect(dirty).toBeGreaterThanOrEqual(target);
    expect(dirty).toBeGreaterThan(64 * 1024 * 1024);
  });

  it("derives the default limit from the heap limit, not from heap usage", async () => {
    const limit = defaultBackupBlobLimit();
    const before = limit;
    // Allocate and hold: usage moves, the limit must not.
    const held: unknown[] = [];
    for (let round = 0; round < 40; round++) {
      const chunk = new Array(30_000);
      for (let at = 0; at < 30_000; at++) chunk[at] = { k: round * at };
      held.push(chunk);
    }
    expect(defaultBackupBlobLimit()).toBe(before);
    expect(held).toHaveLength(40);
    expect(limit).toBeGreaterThan(16 * 1024 * 1024);
  });
});

/**
 * Issue #1031: the weekly and manual backup kept the stored copy as one string
 * before writing it, and at 1.25 million measurements that string and the
 * driver's copies of it added about 640 MB to the process. `packBackupBlobInto`
 * hands the stored copy on in bounded pieces instead, as it is produced.
 */
describe("piecewise envelope", () => {
  /** JSON that gzip cannot shrink much, so the stored copy is several MB. */
  function incompressibleJson(bytes: number): string {
    return JSON.stringify({
      noise: randomBytes(Math.ceil((bytes * 3) / 4)).toString("base64"),
    });
  }

  it("delivers pieces that concatenate to a blob reading back the exact JSON", async () => {
    const json = sampleJson(3_000);
    const pieces: string[] = [];
    await packBackupBlobInto(
      (piece) => {
        pieces.push(piece);
      },
      async (write) => {
        for (let at = 0; at < json.length; at += 4_096) {
          await write(json.slice(at, at + 4_096));
        }
      },
    );
    expect(unpackBackupBlob(pieces.join(""))).toBe(json);
  });

  it("hands pieces on while the producer is still writing, each one bounded", async () => {
    const json = incompressibleJson(12 * 1024 * 1024);
    const pieces: number[] = [];
    let producing = false;
    let piecesWhileProducing = 0;
    const chunks: string[] = [];

    await packBackupBlobInto(
      (piece) => {
        pieces.push(piece.length);
        chunks.push(piece);
        if (producing) piecesWhileProducing += 1;
      },
      async (write) => {
        producing = true;
        for (let at = 0; at < json.length; at += 64 * 1024) {
          await write(json.slice(at, at + 64 * 1024));
        }
        producing = false;
      },
      { maxBytes: Number.MAX_SAFE_INTEGER },
    );

    expect(pieces.length).toBeGreaterThan(2);
    expect(piecesWhileProducing).toBeGreaterThan(1);
    // The flush threshold is 4 MB; one gzip chunk's worth of slack on top.
    for (const length of pieces) {
      expect(length).toBeLessThan(4 * 1024 * 1024 + 256 * 1024);
    }
    expect(unpackBackupBlob(chunks.join(""))).toBe(json);
  });
});
