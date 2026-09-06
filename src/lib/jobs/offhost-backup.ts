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
 * limited to PutObject + GetObject + AbortMultipartUpload, so a compromised
 * worker cannot wipe the backup history. The abort is what cleans up a run
 * that failed partway rather than leaving billed, unlistable parts behind;
 * `AbortMultipartUpload` can only touch an upload this worker started, never
 * a finished object. See docs/ops/backup-restore.md.
 */
import { Buffer } from "node:buffer";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { Transform, type Readable } from "node:stream";
import { createGzip, gunzipSync, gzipSync } from "node:zlib";
import type { PrismaClient } from "@/generated/prisma/client";
import { createRawStreamEncryptor, decryptRawStream } from "@/lib/crypto";
import { streamFullBackupJson } from "@/lib/export/full-backup-stream";
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
 * The envelope one off-host object is written in.
 *
 * Wire format (binary), by version byte:
 *   1: magic(4)="HLBK" || 0x01 || iv(12) || tag(16) || ciphertext(json)
 *   2: magic(4)="HLBK" || 0x02 || iv(12) || tag(16) || ciphertext(gzip(json))
 *   3: magic(4)="HLBK" || 0x03 || iv(12) || ciphertext(gzip(json)) || tag(16)
 *
 * Version 1 encrypted the JSON directly; version 2 gzipped it first. Both put
 * the tag in front of the ciphertext, and that is precisely what could not be
 * written a piece at a time: GCM only produces the tag once the last block is
 * in, so a leading tag means the whole object has to exist before its first
 * byte can be emitted. Version 3 moves the tag to the end and changes nothing
 * else about the authentication — it still covers every ciphertext byte, and
 * `decryptBackup` still verifies it before returning a single byte of
 * plaintext. It is the same move `~hlgcm1.` made for the in-database blob, and
 * it uses the same writer.
 *
 * Every version reads. An operator's bucket holds objects written by whichever
 * release was running that night, and the newest usable copy is exactly the one
 * that must not need a matching binary; `decryptBackup` takes all three and
 * neither `scripts/restore-backup.ts` nor the monthly restore drill needs to
 * know which it got.
 */
const BACKUP_ENVELOPE_PLAIN = 0x01;
const BACKUP_ENVELOPE_GZIP = 0x02;
const BACKUP_ENVELOPE_STREAM = 0x03;
const MAGIC = "HLBK";
/** magic(4) + version(1). Where the per-version body begins. */
const PREAMBLE_LENGTH = 5;

/**
 * Write a whole JSON string as a version-2 object.
 *
 * The job does not use this any more — it streams, and a streaming writer
 * cannot produce a leading tag. It stays because version 2 is the shape
 * sitting in every operator's bucket today, and the test that proves both
 * shapes restore has to write a genuine old object rather than a hand-built
 * byte string that only looks like one.
 */
export function encryptBackup(plaintext: string, key: Buffer): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ct = Buffer.concat([
    cipher.update(gzipSync(plaintext)),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  const header = Buffer.from([
    ...Buffer.from(MAGIC, "binary"),
    BACKUP_ENVELOPE_GZIP,
  ]);
  return Buffer.concat([header, iv, tag, ct]);
}

export function decryptBackup(buf: Buffer, key: Buffer): string {
  const magic = buf.subarray(0, 4).toString("binary");
  const version = buf[PREAMBLE_LENGTH - 1];
  if (
    magic !== MAGIC ||
    (version !== BACKUP_ENVELOPE_PLAIN &&
      version !== BACKUP_ENVELOPE_GZIP &&
      version !== BACKUP_ENVELOPE_STREAM)
  ) {
    throw new Error("Invalid backup envelope (bad magic or version)");
  }
  if (version === BACKUP_ENVELOPE_STREAM) {
    // iv | ciphertext | tag, exactly what the streaming writer emits and what
    // the shared reader verifies whole before it hands back a byte.
    const plaintext = decryptRawStream(buf.subarray(PREAMBLE_LENGTH), key);
    return gunzipSync(plaintext).toString("utf8");
  }
  const iv = buf.subarray(PREAMBLE_LENGTH, PREAMBLE_LENGTH + IV_LENGTH);
  const tag = buf.subarray(
    PREAMBLE_LENGTH + IV_LENGTH,
    PREAMBLE_LENGTH + IV_LENGTH + TAG_LENGTH,
  );
  const ct = buf.subarray(PREAMBLE_LENGTH + IV_LENGTH + TAG_LENGTH);
  const dec = createDecipheriv(ALGORITHM, key, iv);
  dec.setAuthTag(tag);
  const plaintext = Buffer.concat([dec.update(ct), dec.final()]);
  return version === BACKUP_ENVELOPE_GZIP
    ? gunzipSync(plaintext).toString("utf8")
    : plaintext.toString("utf8");
}

/**
 * How much of one object the upload holds at a time, and how many of those
 * windows are in flight. `@aws-sdk/lib-storage` buffers `partSize` bytes per
 * queued part, so this pair — not the object — is the upload's footprint:
 * 16 MB, whatever the record turns out to be.
 */
const UPLOAD_PART_BYTES = 8 * 1024 * 1024;
const UPLOAD_CONCURRENCY = 2;

/**
 * The largest object one multipart upload can carry: S3 and every compatible
 * target cap a multipart upload at 10 000 parts.
 *
 * This is the only ceiling the write path still has. Nothing here grows with
 * the record any more — the JSON is produced a page at a time, gzip and the
 * cipher consume it as it arrives, and the upload holds two parts — so there
 * is no memory bound left to state, and inventing one would be theatre. What
 * remains is structural: past 10 000 parts the SDK fails the upload partway
 * through with an error about part numbers, having already written most of the
 * object. Counting the bytes as they are produced turns that into one clear
 * refusal, and the count is what the test drives against a small limit.
 */
const MAX_MULTIPART_PARTS = 10_000;

/** Default cap for one uploaded object, in bytes. */
export function defaultOffhostObjectLimit(): number {
  return UPLOAD_PART_BYTES * MAX_MULTIPART_PARTS;
}

/** Bytes as an operator reads them. Kilobytes below a megabyte. */
function size(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return mb < 100 ? `${mb.toFixed(1)} MB` : `${Math.round(mb)} MB`;
}

/**
 * Thrown when one account's encrypted object outgrows what a single multipart
 * upload can carry. That account's backup fails; every other account's still
 * runs, and nothing partial is left in the bucket.
 */
export class OffhostBackupTooLargeError extends Error {
  readonly bytes: number;
  readonly limitBytes: number;

  constructor(bytes: number, limitBytes: number) {
    super(
      `Off-host backup stopped after ${size(bytes)} of encrypted backup for ` +
        `one account, over the ${size(limitBytes)} a single object may ` +
        `occupy (${MAX_MULTIPART_PARTS} parts of ${size(UPLOAD_PART_BYTES)}). ` +
        `Nothing was uploaded for this account.`,
    );
    this.name = "OffhostBackupTooLargeError";
    this.bytes = bytes;
    this.limitBytes = limitBytes;
  }
}

/**
 * gzip bytes in, framed version-3 object bytes out, counted as they go.
 *
 * The header is emitted lazily so it rides in front of the first ciphertext
 * piece rather than needing a separate write, and on `flush` when there was no
 * plaintext at all — an empty object is still a well-formed envelope.
 */
function createEnvelopeStream(
  key: Buffer,
  limitBytes: number,
): { stream: Transform; bytes: () => number } {
  const encryptor = createRawStreamEncryptor(key);
  const header = Buffer.concat([
    Buffer.from(MAGIC, "binary"),
    Buffer.from([BACKUP_ENVELOPE_STREAM]),
    encryptor.iv,
  ]);
  let written = 0;
  let headerEmitted = false;

  const take = (piece: Buffer): Buffer => {
    written += piece.byteLength;
    if (written > limitBytes) {
      throw new OffhostBackupTooLargeError(written, limitBytes);
    }
    return piece;
  };

  const preamble = (into: Buffer[]): void => {
    if (headerEmitted) return;
    headerEmitted = true;
    into.push(take(header));
  };

  const stream = new Transform({
    transform(chunk: Buffer, _encoding, callback): void {
      try {
        const out: Buffer[] = [];
        preamble(out);
        const piece = encryptor.update(chunk);
        if (piece.byteLength > 0) out.push(take(piece));
        callback(null, Buffer.concat(out));
      } catch (err) {
        callback(err as Error);
      }
    },
    flush(callback): void {
      try {
        const out: Buffer[] = [];
        preamble(out);
        out.push(take(encryptor.final()));
        callback(null, Buffer.concat(out));
      } catch (err) {
        callback(err as Error);
      }
    },
  });

  return { stream, bytes: () => written };
}

/** Produces the backup JSON in pieces. Every piece is written in order. */
export type BackupJsonProducer = (
  write: (chunk: string) => Promise<void>,
) => Promise<unknown>;

export interface UploadBackupOptions {
  /**
   * Largest object this call may upload, in bytes. Defaults to
   * `defaultOffhostObjectLimit()`. Tests pass an explicit value; nothing else
   * should need to.
   */
  maxBytes?: number;
}

/**
 * Produce one account's backup JSON and put it in the bucket, holding none of
 * it.
 *
 * JSON piece → gzip → AES-256-GCM → multipart upload, with backpressure the
 * whole way: the gzip stream's `write` tells the producer when to wait, the
 * envelope only ever holds one chunk, and the uploader holds
 * `UPLOAD_CONCURRENCY` parts. What the process holds is therefore fixed by
 * this pipeline's shape rather than by the size of the record going through
 * it — which is the entire difference from what this job did before, where the
 * JSON string, the gzip buffer, the ciphertext and the request body were all
 * resident at once.
 *
 * Answers the number of object bytes written.
 */
export async function uploadEncryptedBackup(
  s3: S3Like,
  objectKey: string,
  encryptionKey: Buffer,
  produce: BackupJsonProducer,
  options: UploadBackupOptions = {},
): Promise<number> {
  const limitBytes = options.maxBytes ?? defaultOffhostObjectLimit();
  const gzip = createGzip();
  const { stream: envelope, bytes } = createEnvelopeStream(
    encryptionKey,
    limitBytes,
  );

  let failure: unknown = null;
  // Both directions, or one end's failure hangs the other: a gzip error has to
  // reach the uploader, and the envelope refusing an oversized object has to
  // stop the producer.
  gzip.on("error", (err: Error) => {
    failure ??= err;
    envelope.destroy(err);
  });
  envelope.on("error", (err: Error) => {
    failure ??= err;
    // WITH the error, not bare. A bare destroy leaves a producer that is
    // waiting on `drain` waiting forever — the refusal would hang the account
    // it was supposed to fail, which is a worse outcome than the size it was
    // refusing.
    gzip.destroy(err);
  });
  gzip.pipe(envelope);

  // Started before the producer runs: the uploader is what drains the
  // envelope, and without a reader the first part's worth of backpressure
  // would stall the producer forever.
  const uploaded = s3.putStream(objectKey, envelope).then(
    () => null,
    (err: unknown) => {
      // A refused upload takes the reader away, and a producer that is
      // waiting on `drain` would wait for a reader that is never coming
      // back. Tearing the pipeline down here is what turns "the bucket said
      // no" into a failed account rather than a job that never returns.
      failure ??= err;
      gzip.destroy(err instanceof Error ? err : new Error(String(err)));
      return err;
    },
  );

  const write = async (chunk: string): Promise<void> => {
    if (failure) throw failure;
    if (gzip.write(chunk, "utf8")) return;
    await new Promise<void>((resolve, reject) => {
      const onDrain = (): void => {
        gzip.off("error", onError);
        resolve();
      };
      const onError = (err: Error): void => {
        gzip.off("drain", onDrain);
        reject(err);
      };
      gzip.once("drain", onDrain);
      gzip.once("error", onError);
    });
  };

  try {
    await produce(write);
    gzip.end();
  } catch (err) {
    gzip.destroy();
    envelope.destroy();
    // Settled, not ignored: tearing the pipeline down makes the uploader
    // reject too, and an unawaited rejection would surface later with nothing
    // around it. What it says is only an echo — the producer's own failure is
    // the one that explains the run, and when the envelope refused the object
    // the producer already rethrew that refusal verbatim.
    await uploaded;
    throw err;
  }

  const uploadError = await uploaded;
  if (failure) throw failure;
  if (uploadError) throw uploadError;
  return bytes();
}

export interface S3Like {
  putObject(key: string, body: Buffer | Uint8Array): Promise<void>;
  /**
   * Put an object whose body arrives as a stream, without buffering it.
   *
   * Separate from `putObject` rather than an overload of it: the one-byte
   * health check wants a plain PUT and a test double wants a value it can
   * assert on, while this arm has to be a multipart upload and has to consume
   * what it is given.
   */
  putStream(key: string, body: Readable): Promise<void>;
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
    putStream: async (key, body) => {
      // Dynamic for the same reason as the client above: an environment
      // without the SDK must still be able to import this module.
      const storage = (await import("@aws-sdk/lib-storage").catch((err) => {
        throw new Error(
          `@aws-sdk/lib-storage is not installed (${(err as Error).message}). ` +
            `Run: pnpm add @aws-sdk/lib-storage`,
        );
      })) as typeof import("@aws-sdk/lib-storage");

      const upload = new storage.Upload({
        client,
        params: {
          Bucket: cfg.bucket,
          Key: key,
          Body: body,
          ContentType: "application/octet-stream",
        },
        queueSize: UPLOAD_CONCURRENCY,
        partSize: UPLOAD_PART_BYTES,
        // A failed upload leaves nothing behind. Orphaned parts are billed
        // and are invisible in a bucket listing, so an operator would never
        // find them.
        leavePartsOnError: false,
      });
      await upload.done();
    },
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
  /** The biggest object this run wrote. Tracks the record over time. */
  largestObjectBytes: number;
  /** Accounts refused for size rather than failed for a reason. */
  oversized: number;
}

export type RunOffhostBackupOptions = UploadBackupOptions;

export async function runOffhostBackup(
  prisma: PrismaClient,
  s3Override?: S3Like,
  now: Date = new Date(),
  options: RunOffhostBackupOptions = {},
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
  let oversized = 0;
  let largestObjectBytes = 0;
  const failures: Array<{ userId: string; message: string }> = [];
  const evt = getEvent();
  for (const user of users) {
    try {
      const objectBytes = await uploadEncryptedBackup(
        s3,
        `${dateKey}/user-${user.id}.json.enc`,
        cfg.encryptionKey,
        // The same writer the weekly in-database pass uses. The payload
        // builder was always shared; everything after it was not, which is why
        // this job kept dying on a record the weekly one had learned to
        // survive.
        (write) =>
          streamFullBackupJson(prisma, user.id, write, {
            purpose: "disaster-recovery",
            exportedAt: now,
          }),
        options,
      );
      largestObjectBytes = Math.max(largestObjectBytes, objectBytes);
      uploaded++;
    } catch (err) {
      failed++;
      if (err instanceof OffhostBackupTooLargeError) oversized++;
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
    largestObjectBytes,
    oversized,
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
