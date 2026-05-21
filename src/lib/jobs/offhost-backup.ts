/**
 * Off-host encrypted backup uploader (v1.4 G1).
 *
 * Each user's daily JSON dump is encrypted with AES-256-GCM under a
 * SEPARATE key (`BACKUP_ENCRYPTION_KEY`) so a leak of the application
 * `ENCRYPTION_KEY` does NOT expose the off-host backups, and vice
 * versa. Ciphertext is uploaded to an S3-compatible target (Cloudflare
 * R2, AWS S3, MinIO, Backblaze B2 — anything that speaks the SigV4
 * protocol) using `@aws-sdk/client-s3`.
 *
 * Object key layout:
 *   <bucket>/<YYYY-MM-DD>/user-<userId>.json.enc
 *
 * Retention: the worker NEVER calls DeleteObject on backup keys. Operators
 * MUST configure a bucket-level lifecycle rule (e.g. expire after
 * `BACKUP_RETENTION_DAYS`). This keeps the IAM grant for the worker
 * limited to PutObject + GetObject, so a compromised worker cannot wipe
 * the backup history. See docs/ops/backup-restore.md.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { PrismaClient } from "@/generated/prisma/client";
import { getEvent } from "@/lib/logging/context";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export interface OffhostBackupConfig {
  endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  region: string;
  encryptionKey: Buffer;
  retentionDays: number;
}

export class OffhostBackupNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OffhostBackupNotConfiguredError";
  }
}

function decodeBackupKey(raw: string): Buffer {
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, "hex");
  if (/^[A-Za-z0-9+/=]+$/.test(raw)) {
    const buf = Buffer.from(raw, "base64");
    if (buf.length === 32) return buf;
  }
  throw new Error(
    "BACKUP_ENCRYPTION_KEY must be 64 hex chars or 32-byte base64",
  );
}

export function loadOffhostConfig(): OffhostBackupConfig | null {
  const endpoint = process.env.BACKUP_S3_ENDPOINT;
  const bucket = process.env.BACKUP_S3_BUCKET;
  const accessKey = process.env.BACKUP_S3_ACCESS_KEY;
  const secretKey = process.env.BACKUP_S3_SECRET_KEY;
  const encRaw = process.env.BACKUP_ENCRYPTION_KEY;
  if (!endpoint || !bucket || !accessKey || !secretKey || !encRaw) return null;

  const retentionDays = (() => {
    const raw = process.env.BACKUP_RETENTION_DAYS;
    if (!raw) return 30;
    const v = parseInt(raw, 10);
    return Number.isFinite(v) && v >= 1 ? v : 30;
  })();

  return {
    endpoint,
    bucket,
    accessKey,
    secretKey,
    region: process.env.BACKUP_S3_REGION ?? "auto",
    encryptionKey: decodeBackupKey(encRaw),
    retentionDays,
  };
}

/**
 * Encrypt a JSON payload with the dedicated backup key.
 *
 * Wire format (binary):
 *   magic(4)="HLBK" || version(1)=0x01 || iv(12) || tag(16) || ciphertext
 */
export function encryptBackup(plaintext: string, key: Buffer): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from("HLBK\x01", "binary"), iv, tag, ct]);
}

export function decryptBackup(buf: Buffer, key: Buffer): string {
  const magic = buf.subarray(0, 4).toString("binary");
  const version = buf[4];
  if (magic !== "HLBK" || version !== 0x01) {
    throw new Error("Invalid backup envelope (bad magic or version)");
  }
  const iv = buf.subarray(5, 5 + IV_LENGTH);
  const tag = buf.subarray(5 + IV_LENGTH, 5 + IV_LENGTH + TAG_LENGTH);
  const ct = buf.subarray(5 + IV_LENGTH + TAG_LENGTH);
  const dec = createDecipheriv(ALGORITHM, key, iv);
  dec.setAuthTag(tag);
  return Buffer.concat([dec.update(ct), dec.final()]).toString("utf8");
}

interface S3Like {
  putObject(key: string, body: Buffer | Uint8Array): Promise<void>;
  getObject(key: string): Promise<Buffer>;
  headObject(key: string): Promise<boolean>;
  listObjects(
    prefix: string,
  ): Promise<Array<{ key: string; lastModified?: Date }>>;
  deleteObject(key: string): Promise<void>;
}

export async function getS3Client(cfg: OffhostBackupConfig): Promise<S3Like> {
  // Dynamic import so unit tests + dev environments without the SDK don't fail.
  const mod = (await import("@aws-sdk/client-s3").catch((err) => {
    throw new Error(
      `@aws-sdk/client-s3 is not installed (${(err as Error).message}). ` +
        `Run: pnpm add @aws-sdk/client-s3`,
    );
  })) as typeof import("@aws-sdk/client-s3");

  const client = new mod.S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region,
    forcePathStyle: true,
    credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
  });

  const collect = async (stream: unknown): Promise<Buffer> => {
    const chunks: Buffer[] = [];
    for await (const c of stream as AsyncIterable<Uint8Array>) {
      chunks.push(Buffer.from(c as Uint8Array));
    }
    return Buffer.concat(chunks);
  };

  return {
    putObject: async (key, body) => {
      await client.send(
        new mod.PutObjectCommand({
          Bucket: cfg.bucket,
          Key: key,
          Body: body,
          ContentType: "application/octet-stream",
        }),
      );
    },
    getObject: async (key) => {
      const out = await client.send(
        new mod.GetObjectCommand({ Bucket: cfg.bucket, Key: key }),
      );
      return collect(out.Body);
    },
    headObject: async (key) => {
      try {
        await client.send(
          new mod.HeadObjectCommand({ Bucket: cfg.bucket, Key: key }),
        );
        return true;
      } catch {
        return false;
      }
    },
    listObjects: async (prefix) => {
      const out = await client.send(
        new mod.ListObjectsV2Command({ Bucket: cfg.bucket, Prefix: prefix }),
      );
      return (out.Contents ?? []).map((c) => ({
        key: c.Key ?? "",
        lastModified: c.LastModified,
      }));
    },
    deleteObject: async (key) => {
      await client.send(
        new mod.DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }),
      );
    },
  };
}

interface BackupRunReport {
  config: { endpoint: string; bucket: string; region: string };
  uploaded: number;
  failed: number;
  failures: Array<{ userId: string; message: string }>;
  totalUsers: number;
}

export async function runOffhostBackup(
  prisma: PrismaClient,
  s3Override?: S3Like,
  now: Date = new Date(),
): Promise<BackupRunReport> {
  const cfg = loadOffhostConfig();
  if (!cfg) {
    throw new OffhostBackupNotConfiguredError(
      "Off-host backup not configured. Set BACKUP_S3_ENDPOINT/BUCKET/ACCESS_KEY/SECRET_KEY and BACKUP_ENCRYPTION_KEY.",
    );
  }
  const s3 = s3Override ?? (await getS3Client(cfg));
  const dateKey = now.toISOString().slice(0, 10);

  const users = await prisma.user.findMany({ select: { id: true } });
  let uploaded = 0;
  let failed = 0;
  const failures: Array<{ userId: string; message: string }> = [];
  const evt = getEvent();
  for (const user of users) {
    try {
      const [measurements, medications, intakeEvents, moodEntries] =
        await Promise.all([
          // includes soft-deleted rows because this is the DR snapshot,
          // not a user-facing export — see
          // `/api/export/full-backup/route.ts` for the symmetric exclusion.
          prisma.measurement.findMany({ where: { userId: user.id } }),
          prisma.medication.findMany({
            where: { userId: user.id },
            include: { schedules: true },
          }),
          prisma.medicationIntakeEvent.findMany({ where: { userId: user.id } }),
          prisma.moodEntry.findMany({ where: { userId: user.id } }),
        ]);

      const payload = JSON.stringify({
        exportedAt: now.toISOString(),
        userId: user.id,
        measurements,
        medications,
        intakeEvents,
        moodEntries,
      });

      const ciphertext = encryptBackup(payload, cfg.encryptionKey);
      const key = `${dateKey}/user-${user.id}.json.enc`;
      await s3.putObject(key, ciphertext);
      uploaded++;
    } catch (err) {
      failed++;
      const message = (err as Error).message ?? "unknown";
      failures.push({ userId: user.id, message: message.slice(0, 200) });
      // Surface per-user failure detail so an operator can tell WHICH user
      // failed and WHY without scraping stdout.
      evt?.addWarning(
        `offhost-backup user ${user.id} failed: ${message.slice(0, 200)}`,
      );
    }
  }

  return {
    config: {
      endpoint: cfg.endpoint,
      bucket: cfg.bucket,
      region: cfg.region,
    },
    uploaded,
    failed,
    failures,
    totalUsers: users.length,
  };
}

export interface RoundtripReport {
  endpoint: string;
  bucket: string;
  region: string;
  putLatencyMs: number;
  getLatencyMs: number;
  ok: boolean;
  error?: string;
}

/**
 * Test-button helper: write + read a tiny object so the admin UI can
 * confirm the bucket + creds work. Never returns the credentials.
 */
export async function runOffhostRoundtripTest(
  s3Override?: S3Like,
): Promise<RoundtripReport> {
  const cfg = loadOffhostConfig();
  if (!cfg) {
    throw new OffhostBackupNotConfiguredError(
      "Off-host backup is not configured.",
    );
  }
  const s3 = s3Override ?? (await getS3Client(cfg));
  const key = `_healthcheck/${Date.now()}.bin`;
  const body = Buffer.from([0x42]);
  const t0 = Date.now();
  try {
    await s3.putObject(key, body);
    const putLatencyMs = Date.now() - t0;
    const t1 = Date.now();
    const got = await s3.getObject(key);
    const getLatencyMs = Date.now() - t1;
    await s3.deleteObject(key).catch(() => {});
    return {
      endpoint: cfg.endpoint,
      bucket: cfg.bucket,
      region: cfg.region,
      putLatencyMs,
      getLatencyMs,
      ok: got.length === 1 && got[0] === 0x42,
    };
  } catch (err) {
    return {
      endpoint: cfg.endpoint,
      bucket: cfg.bucket,
      region: cfg.region,
      putLatencyMs: -1,
      getLatencyMs: -1,
      ok: false,
      error: (err as Error).message,
    };
  }
}
