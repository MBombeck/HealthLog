import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  encryptBackup,
  decryptBackup,
  loadOffhostConfig,
  runOffhostBackup,
  runOffhostRoundtripTest,
} from "../offhost-backup";

const ENC_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("offhost-backup envelope", () => {
  it("encrypts and decrypts JSON round-trip", () => {
    const key = Buffer.from(ENC_KEY, "hex");
    const payload = JSON.stringify({ hello: "world", n: 42 });
    const buf = encryptBackup(payload, key);
    expect(buf.subarray(0, 5).toString("binary")).toBe("HLBK\x01");
    expect(decryptBackup(buf, key)).toBe(payload);
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
    vi.stubEnv("BACKUP_S3_ENDPOINT", "https://r2.example");
    vi.stubEnv("BACKUP_S3_BUCKET", "hl-backups");
    vi.stubEnv("BACKUP_S3_ACCESS_KEY", "AKIA");
    vi.stubEnv("BACKUP_S3_SECRET_KEY", "secret");
    vi.stubEnv("BACKUP_S3_REGION", "auto");
    vi.stubEnv("BACKUP_ENCRYPTION_KEY", ENC_KEY);
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
  });

  it("counts per-user failures without aborting the whole run", async () => {
    const s3 = makeS3Mock();
    const prisma = {
      user: {
        findMany: vi.fn().mockResolvedValue([{ id: "u1" }, { id: "u2" }]),
      },
      measurement: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([])
          .mockRejectedValueOnce(new Error("db gone")),
      },
      medication: { findMany: vi.fn().mockResolvedValue([]) },
      medicationIntakeEvent: { findMany: vi.fn().mockResolvedValue([]) },
      moodEntry: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const report = await runOffhostBackup(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma as any,
      s3,
      new Date("2026-05-08T00:00:00Z"),
    );
    expect(report.uploaded).toBe(1);
    expect(report.failed).toBe(1);
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
