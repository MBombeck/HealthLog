import { createCipheriv, randomBytes } from "node:crypto";
import type { Readable } from "node:stream";

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  BACKUP_SCHEMA_VERSION,
  backupPayloadSchema,
} from "@/lib/validations/backup";

const mocks = vi.hoisted(() => ({
  buildFullBackupPayload: vi.fn(),
}));

// Only the payload builder is stubbed. The REAL streaming writer runs on top
// of it, so every case below keeps stubbing the PAYLOAD — which is what these
// tests are about — while the framing that turns it into object bytes is the
// framing the job actually uses. `isDeferredRows` rides along because the
// writer asks it about every section; nothing here defers.
vi.mock("@/lib/export/full-backup-payload", () => ({
  buildFullBackupPayload: mocks.buildFullBackupPayload,
  isDeferredRows: () => false,
}));
import {
  encryptBackup,
  decryptBackup,
  loadOffhostConfig,
  runOffhostBackup,
  runOffhostRoundtripTest,
  uploadEncryptedBackup,
} from "../offhost-backup";

const ENC_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("offhost-backup envelope", () => {
  it("encrypts and decrypts JSON round-trip", () => {
    const key = Buffer.from(ENC_KEY, "hex");
    const payload = JSON.stringify({ hello: "world", n: 42 });
    const buf = encryptBackup(payload, key);
    // Version 2: the plaintext is gzipped before the cipher sees it. This
    // assertion used to pin version 1, which is the version that could not
    // encrypt a large account's dump without four full copies of it resident
    // at once. The pin is flipped rather than dropped — the byte is the whole
    // reason a reader can tell the two apart.
    expect(buf.subarray(0, 5).toString("binary")).toBe("HLBK\x02");
    expect(decryptBackup(buf, key)).toBe(payload);
  });

  it("still reads a version-1 object written before compression", () => {
    const key = Buffer.from(ENC_KEY, "hex");
    const payload = JSON.stringify({ hello: "world", n: 42 });
    // Hand-built v1 envelope: magic || 0x01 || iv || tag || ciphertext, the
    // exact bytes every object already sitting in an operator's bucket has.
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);
    const legacy = Buffer.concat([
      Buffer.from("HLBK\x01", "binary"),
      iv,
      cipher.getAuthTag(),
      ct,
    ]);

    expect(decryptBackup(legacy, key)).toBe(payload);
  });

  it("rejects tampered ciphertext", () => {
    const key = Buffer.from(ENC_KEY, "hex");
    const buf = encryptBackup("data", key);
    const tampered = Buffer.from(buf);
    tampered[tampered.length - 1] ^= 0xff;
    expect(() => decryptBackup(tampered, key)).toThrow();
  });

  it("rejects bad magic / version", () => {
    const key = Buffer.from(ENC_KEY, "hex");
    const buf = encryptBackup("data", key);
    const bad = Buffer.from(buf);
    bad[0] = 0; // corrupt magic
    expect(() => decryptBackup(bad, key)).toThrow(/Invalid backup envelope/);
  });
});

describe("loadOffhostConfig", () => {
  beforeEach(() => vi.unstubAllEnvs());

  it("returns null if any of the required vars is missing", () => {
    vi.stubEnv("BACKUP_S3_ENDPOINT", "");
    expect(loadOffhostConfig()).toBeNull();
  });

  it("parses a complete config", () => {
    vi.stubEnv("BACKUP_S3_ENDPOINT", "https://r2.example");
    vi.stubEnv("BACKUP_S3_BUCKET", "hl-backups");
    vi.stubEnv("BACKUP_S3_ACCESS_KEY", "AKIA");
    vi.stubEnv("BACKUP_S3_SECRET_KEY", "secret");
    vi.stubEnv("BACKUP_S3_REGION", "auto");
    vi.stubEnv("BACKUP_ENCRYPTION_KEY", ENC_KEY);
    const cfg = loadOffhostConfig();
    expect(cfg).not.toBeNull();
    expect(cfg!.bucket).toBe("hl-backups");
    expect(cfg!.endpoint).toBe("https://r2.example");
    expect(cfg!.region).toBe("auto");
    expect(cfg!.encryptionKey.length).toBe(32);
    expect(cfg!.retentionDays).toBe(30);
  });
});

function makeS3Mock() {
  const store = new Map<string, Buffer>();
  return {
    store,
    // Consumes what it is given rather than storing the stream: the upload
    // path is what applies backpressure to the producer, so a double that did
    // not read would deadlock instead of failing.
    putStream: vi.fn(async (k: string, body: Readable) => {
      const chunks: Buffer[] = [];
      for await (const c of body) chunks.push(Buffer.from(c as Uint8Array));
      store.set(k, Buffer.concat(chunks));
    }),
    putObject: vi.fn(async (k: string, b: Buffer) => {
      store.set(k, Buffer.from(b));
    }),
    getObject: vi.fn(async (k: string) => {
      const v = store.get(k);
      if (!v) throw new Error("not found");
      return v;
    }),
    headObject: vi.fn(async (k: string) => store.has(k)),
    listObjects: vi.fn(async (prefix: string) =>
      Array.from(store.keys())
        .filter((k) => k.startsWith(prefix))
        .map((key) => ({ key })),
    ),
    deleteObject: vi.fn(async (k: string) => {
      store.delete(k);
    }),
  };
}

describe("runOffhostBackup", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    vi.stubEnv("BACKUP_S3_ENDPOINT", "https://r2.example");
    vi.stubEnv("BACKUP_S3_BUCKET", "hl-backups");
    vi.stubEnv("BACKUP_S3_ACCESS_KEY", "AKIA");
    vi.stubEnv("BACKUP_S3_SECRET_KEY", "secret");
    vi.stubEnv("BACKUP_S3_REGION", "auto");
    vi.stubEnv("BACKUP_ENCRYPTION_KEY", ENC_KEY);
    mocks.buildFullBackupPayload.mockImplementation(
      async (_prisma: unknown, userId: string) => ({
        payload: {
          schemaVersion: BACKUP_SCHEMA_VERSION,
          exportedAt: "2026-05-08T03:00:00.000Z",
          userId,
          measurements: [],
          medications: [],
          intakeEvents: [],
          moodEntries: [
            {
              id: `mood-${userId}`,
              date: "2026-05-08",
              mood: "GUT",
              score: 4,
              loggedAt: "2026-05-08T20:00:00.000Z",
              factors: [],
            },
          ],
        },
        counts: {},
      }),
    );
  });

  it("uploads one object per user and never deletes existing ones", async () => {
    const s3 = makeS3Mock();
    // Pre-seed an old object — the worker must NOT touch it. Retention is
    // the bucket's lifecycle-policy job; the worker's IAM grant is
    // intentionally PutObject + GetObject only.
    s3.store.set("2020-01-01/user-old.json.enc", Buffer.from([0]));

    const prisma = {
      user: {
        findMany: vi.fn().mockResolvedValue([{ id: "u1" }, { id: "u2" }]),
      },
      measurement: { findMany: vi.fn().mockResolvedValue([]) },
      medication: { findMany: vi.fn().mockResolvedValue([]) },
      medicationIntakeEvent: { findMany: vi.fn().mockResolvedValue([]) },
      moodEntry: { findMany: vi.fn().mockResolvedValue([]) },
      cycleProfile: { findUnique: vi.fn().mockResolvedValue(null) },
      menstrualCycle: { findMany: vi.fn().mockResolvedValue([]) },
      cycleDayLog: { findMany: vi.fn().mockResolvedValue([]) },
    };

    const now = new Date("2026-05-08T03:00:00Z");
    const report = await runOffhostBackup(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma as any,
      s3,
      now,
    );
    expect(report.uploaded).toBe(2);
    expect(report.failed).toBe(0);
    expect(report.totalUsers).toBe(2);
    expect(s3.store.has("2026-05-08/user-u1.json.enc")).toBe(true);
    expect(s3.store.has("2026-05-08/user-u2.json.enc")).toBe(true);
    // Stale object stays — worker has no DeleteObject side-effects.
    expect(s3.store.has("2020-01-01/user-old.json.enc")).toBe(true);
    expect(s3.deleteObject).not.toHaveBeenCalled();

    const ct = s3.store.get("2026-05-08/user-u1.json.enc")!;
    const decoded = decryptBackup(ct, Buffer.from(ENC_KEY, "hex"));
    const parsed = JSON.parse(decoded);
    expect(parsed.userId).toBe("u1");
    expect(() => backupPayloadSchema.parse(parsed)).not.toThrow();
    expect(parsed.schemaVersion).toBe(BACKUP_SCHEMA_VERSION);
    expect(mocks.buildFullBackupPayload).toHaveBeenCalledWith(prisma, "u1", {
      purpose: "disaster-recovery",
      exportedAt: now,
      // The three unbounded tables are declared, not read. Without this the
      // writer is streaming a payload that was materialised first, which is
      // the arrangement that took the container down.
      deferBulk: true,
    });
    // Nothing went through the whole-buffer arm.
    expect(s3.putObject).not.toHaveBeenCalled();
    expect(s3.putStream).toHaveBeenCalledTimes(2);
  });

  it("uploads the canonical builder output without reshaping it", async () => {
    const s3 = makeS3Mock();
    const prisma = {
      user: { findMany: vi.fn().mockResolvedValue([{ id: "u1" }]) },
    };
    const canonicalPayload = {
      schemaVersion: BACKUP_SCHEMA_VERSION,
      exportedAt: "2026-05-08T00:00:00.000Z",
      userId: "u1",
      measurements: [],
      medications: [],
      intakeEvents: [],
      moodEntries: [],
      documents: [
        {
          id: "document-1",
          kind: "LAB_RESULT",
          mimeType: "application/pdf",
          byteSize: 4,
          status: "STORED",
          contentEncrypted: Buffer.from([1, 2, 3, 4]).toString("base64"),
          contentSha256: null,
          contentCodec: "binary2",
          providerType: null,
          reportDate: null,
          documentDate: null,
          errorReason: null,
          summaryEncrypted: null,
          summaryGeneratedAt: null,
          summaryState: "NONE",
          createdAt: "2026-05-08T00:00:00.000Z",
          updatedAt: "2026-05-08T00:00:00.000Z",
        },
      ],
    };
    // A copy, because the streaming writer releases each section from the
    // payload as it goes — that destructive walk is what keeps its peak at one
    // section, and handing it the fixture itself would empty the expectation.
    mocks.buildFullBackupPayload.mockResolvedValueOnce({
      payload: structuredClone(canonicalPayload),
      counts: {},
    });

    const report = await runOffhostBackup(
      prisma as never,
      s3,
      new Date("2026-05-08T00:00:00Z"),
    );

    expect(report.uploaded).toBe(1);
    const ciphertext = s3.store.get("2026-05-08/user-u1.json.enc")!;
    expect(
      JSON.parse(decryptBackup(ciphertext, Buffer.from(ENC_KEY, "hex"))),
    ).toEqual(canonicalPayload);
    expect(() => backupPayloadSchema.parse(canonicalPayload)).not.toThrow();
  });

  it("counts per-user failures without aborting the whole run", async () => {
    const s3 = makeS3Mock();
    const prisma = {
      user: {
        findMany: vi.fn().mockResolvedValue([{ id: "u1" }, { id: "u2" }]),
      },
    };
    mocks.buildFullBackupPayload
      .mockResolvedValueOnce({
        payload: {
          schemaVersion: BACKUP_SCHEMA_VERSION,
          exportedAt: "2026-05-08T00:00:00.000Z",
          userId: "u1",
        },
        counts: {},
      })
      .mockRejectedValueOnce(new Error("db gone"));

    const report = await runOffhostBackup(
      prisma as never,
      s3,
      new Date("2026-05-08T00:00:00Z"),
    );

    expect(report.uploaded).toBe(1);
    expect(report.failed).toBe(1);
  });

  it("refuses an account whose object outgrows one multipart upload", async () => {
    const s3 = makeS3Mock();
    const prisma = {
      user: { findMany: vi.fn().mockResolvedValue([{ id: "u1" }]) },
    };
    mocks.buildFullBackupPayload.mockResolvedValue({
      payload: {
        schemaVersion: BACKUP_SCHEMA_VERSION,
        exportedAt: "2026-05-08T00:00:00.000Z",
        userId: "u1",
        // Incompressible, so the limit is crossed by real object bytes rather
        // than by gzip failing to shrink a repetitive fixture.
        measurements: Array.from({ length: 400 }, (_, at) => ({
          id: `m-${at}`,
          note: randomBytes(64).toString("hex"),
        })),
      },
      counts: {},
    });

    const report = await runOffhostBackup(
      prisma as never,
      s3,
      new Date("2026-05-08T00:00:00Z"),
      { maxBytes: 1024 },
    );

    expect(report.uploaded).toBe(0);
    expect(report.failed).toBe(1);
    expect(report.oversized).toBe(1);
    expect(report.failures[0]?.message).toContain("a single object may occupy");
    // The refusal is the account's, not the process's, and it leaves nothing
    // half-written behind it.
    expect(s3.store.size).toBe(0);
  });

  it("reports the largest object it wrote", async () => {
    const s3 = makeS3Mock();
    const prisma = {
      user: { findMany: vi.fn().mockResolvedValue([{ id: "u1" }]) },
    };
    const report = await runOffhostBackup(
      prisma as never,
      s3,
      new Date("2026-05-08T00:00:00Z"),
    );
    expect(report.largestObjectBytes).toBe(
      s3.store.get("2026-05-08/user-u1.json.enc")!.byteLength,
    );
    expect(report.oversized).toBe(0);
  });
});

describe("uploadEncryptedBackup", () => {
  const key = Buffer.from(ENC_KEY, "hex");

  it("writes a version-3 object that reads back byte for byte", async () => {
    const s3 = makeS3Mock();
    const document = JSON.stringify({
      hello: "world",
      rows: Array.from({ length: 5_000 }, (_, at) => ({ at })),
    });

    const bytes = await uploadEncryptedBackup(s3, "k", key, async (write) => {
      // In pieces, because that is how the real producer arrives.
      for (let at = 0; at < document.length; at += 997) {
        await write(document.slice(at, at + 997));
      }
    });

    const stored = s3.store.get("k")!;
    expect(stored.byteLength).toBe(bytes);
    expect(stored.subarray(0, 5).toString("binary")).toBe("HLBK\x03");
    expect(decryptBackup(stored, key)).toBe(document);
  });

  it("restores an object of the old shape and one of the new one alike", async () => {
    const s3 = makeS3Mock();
    const document = JSON.stringify({ userId: "u1", n: 7 });

    // A genuine version-2 object: the writer that produced every object
    // already sitting in an operator's bucket.
    const legacy = encryptBackup(document, key);
    await s3.putObject("old", legacy);
    await uploadEncryptedBackup(s3, "new", key, (write) => write(document));

    const oldBytes = s3.store.get("old")!;
    const newBytes = s3.store.get("new")!;
    expect(oldBytes.subarray(0, 5).toString("binary")).toBe("HLBK\x02");
    expect(newBytes.subarray(0, 5).toString("binary")).toBe("HLBK\x03");
    // Different framing, same record, one reader.
    expect(decryptBackup(oldBytes, key)).toBe(document);
    expect(decryptBackup(newBytes, key)).toBe(document);
  });

  it("rejects a tampered version-3 object rather than returning a partial one", async () => {
    const s3 = makeS3Mock();
    await uploadEncryptedBackup(s3, "k", key, (write) =>
      write(JSON.stringify({ userId: "u1" })),
    );
    const stored = Buffer.from(s3.store.get("k")!);
    // One flipped bit in the ciphertext body, well clear of the trailing tag.
    stored[20] ^= 0x01;
    expect(() => decryptBackup(stored, key)).toThrow();
  });

  it("fails the upload rather than the process when the producer throws", async () => {
    const s3 = makeS3Mock();
    await expect(
      uploadEncryptedBackup(s3, "k", key, async (write) => {
        await write("{");
        throw new Error("db gone");
      }),
    ).rejects.toThrow("db gone");
    expect(s3.store.has("k")).toBe(false);
  });

  it("stops the producer when the bucket refuses the upload mid-write", async () => {
    const s3 = makeS3Mock();
    // Refused after the producer is already going, and without reading a byte
    // — the shape a rejected CreateMultipartUpload has. The producer is by
    // then waiting on the compressor to drain, and the reader that would have
    // drained it is gone.
    s3.putStream.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      throw new Error("The specified bucket does not exist");
    });

    await expect(
      uploadEncryptedBackup(s3, "k", key, async (write) => {
        // Well past the compressor's buffer, so the wait is real.
        for (let at = 0; at < 200; at++) {
          await write(randomBytes(4096).toString("hex"));
        }
      }),
    ).rejects.toThrow("The specified bucket does not exist");
  });

  it("surfaces the target's own message when the upload is refused", async () => {
    const s3 = makeS3Mock();
    s3.putStream.mockRejectedValueOnce(
      new Error(
        "The request signature we calculated does not match the signature you provided.",
      ),
    );
    await expect(
      uploadEncryptedBackup(s3, "k", key, (write) => write("{}")),
    ).rejects.toThrow("The request signature we calculated");
  });
});

describe("runOffhostRoundtripTest", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("BACKUP_S3_ENDPOINT", "https://r2.example");
    vi.stubEnv("BACKUP_S3_BUCKET", "hl-backups");
    vi.stubEnv("BACKUP_S3_ACCESS_KEY", "AKIA");
    vi.stubEnv("BACKUP_S3_SECRET_KEY", "secret");
    vi.stubEnv("BACKUP_S3_REGION", "auto");
    vi.stubEnv("BACKUP_ENCRYPTION_KEY", ENC_KEY);
  });

  it("returns ok=true when the put+get round-trip succeeds", async () => {
    const s3 = makeS3Mock();
    const r = await runOffhostRoundtripTest(s3);
    expect(r.ok).toBe(true);
    expect(r.bucket).toBe("hl-backups");
    expect(r.endpoint).toBe("https://r2.example");
  });

  it("never leaks credentials in the returned report", async () => {
    const s3 = makeS3Mock();
    const r = await runOffhostRoundtripTest(s3);
    const json = JSON.stringify(r);
    expect(json).not.toContain("AKIA");
    expect(json).not.toContain("secret");
    expect(json).not.toContain(ENC_KEY);
  });
});
