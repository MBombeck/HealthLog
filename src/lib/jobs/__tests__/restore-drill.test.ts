import type { Readable } from "node:stream";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { encryptBackup } from "../offhost-backup";
import {
  handleRestoreDrill,
  runRestoreDrill,
  RESTORE_DRILL_CRON,
  RESTORE_DRILL_QUEUE,
} from "../restore-drill";

vi.mock("../report-worker-error", () => ({
  reportWorkerError: vi.fn().mockResolvedValue(undefined),
}));

import { reportWorkerError } from "../report-worker-error";

const ENC_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const KEY = Buffer.from(ENC_KEY, "hex");

function stubConfigEnv() {
  vi.stubEnv("BACKUP_S3_ENDPOINT", "https://r2.example");
  vi.stubEnv("BACKUP_S3_BUCKET", "hl-backups");
  vi.stubEnv("BACKUP_S3_ACCESS_KEY", "AKIA");
  vi.stubEnv("BACKUP_S3_SECRET_KEY", "secret");
  vi.stubEnv("BACKUP_ENCRYPTION_KEY", ENC_KEY);
}

function makeS3Mock(initial: Record<string, Buffer> = {}) {
  const store = new Map<string, Buffer>(Object.entries(initial));
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
    putObject: vi.fn(async (k: string, b: Buffer | Uint8Array) => {
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

function backupObject(overrides: Record<string, unknown> = {}): Buffer {
  return encryptBackup(
    JSON.stringify({
      exportedAt: "2026-06-01T02:30:00.000Z",
      userId: "user-abc",
      measurements: [{ id: "m1" }, { id: "m2" }],
      medications: [{ id: "med1" }],
      intakeEvents: [],
      moodEntries: [{ id: "mood1" }],
      ...overrides,
    }),
    KEY,
  );
}

describe("runRestoreDrill", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    stubConfigEnv();
  });

  it("exports the agreed queue name and monthly cron slot", () => {
    expect(RESTORE_DRILL_QUEUE).toBe("data-restore-drill");
    expect(RESTORE_DRILL_CRON).toBe("11 4 1 * *");
  });

  it("fetches, decrypts, and parses the newest backup object", async () => {
    const s3 = makeS3Mock({
      "2026-05-30/user-old.json.enc": backupObject(),
      "2026-06-01/user-abc.json.enc": backupObject(),
      "_healthcheck/123.bin": Buffer.from([0x42]),
    });
    const report = await runRestoreDrill(s3, new Date("2026-06-02T04:11:00Z"));
    expect(report.objectKey).toBe("2026-06-01/user-abc.json.enc");
    expect(report.dateKey).toBe("2026-06-01");
    expect(report.ageDays).toBe(1);
    expect(report.stale).toBe(false);
    expect(report.recordCounts).toEqual({
      measurements: 2,
      medications: 1,
      intakeEvents: 0,
      moodEntries: 1,
    });
    expect(s3.getObject).toHaveBeenCalledWith("2026-06-01/user-abc.json.enc");
    // Read-only drill: nothing is ever written or deleted.
    expect(s3.putObject).not.toHaveBeenCalled();
    expect(s3.deleteObject).not.toHaveBeenCalled();
  });

  it("flags the report stale when the newest backup is older than the threshold", async () => {
    const s3 = makeS3Mock({ "2026-05-20/user-abc.json.enc": backupObject() });
    const report = await runRestoreDrill(s3, new Date("2026-06-01T04:11:00Z"));
    expect(report.ageDays).toBe(12);
    expect(report.stale).toBe(true);
  });

  it("throws when the bucket holds no backup-shaped objects", async () => {
    const s3 = makeS3Mock({ "_healthcheck/1.bin": Buffer.from([0x42]) });
    await expect(runRestoreDrill(s3)).rejects.toThrow(/no backup objects/);
  });

  it("throws when the object cannot be decrypted (wrong key / tampering)", async () => {
    const tampered = Buffer.from(backupObject());
    tampered[tampered.length - 1] ^= 0xff;
    const s3 = makeS3Mock({ "2026-06-01/user-abc.json.enc": tampered });
    await expect(runRestoreDrill(s3)).rejects.toThrow();
  });

  it("throws when the payload is missing core fields", async () => {
    const s3 = makeS3Mock({
      "2026-06-01/user-abc.json.enc": encryptBackup(
        JSON.stringify({ exportedAt: "2026-06-01T02:30:00.000Z" }),
        KEY,
      ),
    });
    await expect(runRestoreDrill(s3)).rejects.toThrow(/missing core fields/);
  });

  it("throws OffhostBackupNotConfiguredError when the S3 vars are unset", async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("BACKUP_S3_ENDPOINT", "");
    await expect(runRestoreDrill(makeS3Mock())).rejects.toThrow(
      /not configured/,
    );
  });
});

describe("handleRestoreDrill", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("skips without paging when off-host backup is not configured", async () => {
    vi.stubEnv("BACKUP_S3_ENDPOINT", "");
    await handleRestoreDrill([]);
    expect(reportWorkerError).not.toHaveBeenCalled();
  });

  it("pages via reportWorkerError when the drill fails", async () => {
    stubConfigEnv();
    // Bucket is configured but the AWS SDK client would be constructed
    // against the fake endpoint; force the failure earlier by pointing
    // the loader at an invalid encryption key instead.
    vi.stubEnv("BACKUP_ENCRYPTION_KEY", "not-a-key");
    await handleRestoreDrill([]);
    expect(reportWorkerError).toHaveBeenCalledTimes(1);
    expect(vi.mocked(reportWorkerError).mock.calls[0][0]).toBe(
      RESTORE_DRILL_QUEUE,
    );
  });
});
