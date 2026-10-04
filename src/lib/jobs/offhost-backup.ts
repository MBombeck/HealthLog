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
 * Retention: the worker does not expire objects by age. Operators configure a
 * bucket-level lifecycle rule (e.g. expire after `BACKUP_RETENTION_DAYS`,
 * which this module reads nowhere — see `loadOffhostConfig`); the admin
 * off-host card reads that rule back (`probeOffhostLifecycle`) and says when
 * there is none. Objects ARE deleted in one case: an account that is deleted
 * or whose data is wiped (`offhost-purge.ts`), which needs DeleteObject in the
 * grant. `AbortMultipartUpload` cleans up a run that failed partway rather
 * than leaving billed, unlistable parts behind. See
 * docs/ops/backup-restore.md.
 */
import { envOr } from "@/lib/env";
import { Buffer } from "node:buffer";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { Readable, Transform } from "node:stream";
import { createGunzip, createGzip, gunzipSync, gzipSync } from "node:zlib";
import type { PrismaClient } from "@/generated/prisma/client";
import { createRawStreamEncryptor, decryptRawStream } from "@/lib/crypto";
import { createBackupKeyIdTextScanner } from "@/lib/export/backup-key-ids";
import { streamFullBackupJson } from "@/lib/export/full-backup-stream";
import {
  markBackupAttemptFinished,
  markBackupAttemptStarted,
  orderInterruptedLast,
  readInterruptedBackupAttempts,
} from "@/lib/jobs/backup-pass-attempts";
import { BACKUP_HEARTBEAT_SECONDS } from "@/lib/jobs/data-backup-policy";
import { annotate, getEvent } from "@/lib/logging/context";
import { envValue } from "@/lib/env";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

/**
 * The off-host pass's expiry: four hours. It uploads every account and
 * already stopped between accounts at three quarters of the default fifteen
 * minutes, which on an instance of any size meant a retry per night; one
 * large account past the default was retried beside itself. Four hours with
 * the same budget and a lock (`lockedPass`) leaves room for the night's pass.
 */
export const OFFHOST_BACKUP_EXPIRE_SECONDS = 4 * 60 * 60;

export const OFFHOST_BACKUP_QUEUE = "data-backup-offhost";

/**
 * What the nightly schedule sends with: the four hours above, and the
 * heartbeat that notices a process that died under the pass within minutes
 * rather than at the end of them (`BACKUP_HEARTBEAT_SECONDS`).
 */
export const OFFHOST_BACKUP_SEND_OPTIONS = {
  expireInSeconds: OFFHOST_BACKUP_EXPIRE_SECONDS,
  heartbeatSeconds: BACKUP_HEARTBEAT_SECONDS,
} as const;

export interface OffhostBackupConfig {
  endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  region: string;
  /** The key new objects are written under (`BACKUP_ENCRYPTION_KEY`). */
  encryptionKey: Buffer;
  /**
   * Keys older objects may still be under (`BACKUP_ENCRYPTION_PREVIOUS_KEYS`,
   * comma-separated). Read only; nothing is written under them. This is the
   * rotation path: the new key goes into `BACKUP_ENCRYPTION_KEY`, the old one
   * here, until the bucket's lifecycle rule has retired every object written
   * under it.
   */
  previousEncryptionKeys: Buffer[];
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

/**
 * Whether this host has the five variables the nightly job needs.
 *
 * Separate from `loadOffhostConfig()` because a surface that only wants to say
 * "off-host backup is not set up here" must not decode the encryption key to
 * find out — `decodeBackupKey` throws on a malformed one, and an operator
 * whose key has a typo should see the admin page, not a 500.
 */
export function offhostBackupConfigured(): boolean {
  return OFFHOST_ENV_VARS.every((name) => Boolean(process.env[name]));
}

/** The five variables the nightly job needs, in one place. */
const OFFHOST_ENV_VARS = [
  "BACKUP_S3_ENDPOINT",
  "BACKUP_S3_BUCKET",
  "BACKUP_S3_ACCESS_KEY",
  "BACKUP_S3_SECRET_KEY",
  "BACKUP_ENCRYPTION_KEY",
] as const;

export function loadOffhostConfig(): OffhostBackupConfig | null {
  const endpoint = process.env.BACKUP_S3_ENDPOINT;
  const bucket = process.env.BACKUP_S3_BUCKET;
  const accessKey = process.env.BACKUP_S3_ACCESS_KEY;
  const secretKey = process.env.BACKUP_S3_SECRET_KEY;
  const encRaw = process.env.BACKUP_ENCRYPTION_KEY;
  if (!endpoint || !bucket || !accessKey || !secretKey || !encRaw) return null;

  // `BACKUP_RETENTION_DAYS` is deliberately absent from this config. It used
  // to be parsed and clamped here and then read by nobody, which read as an
  // enforcer the worker is not: retention belongs to the bucket's lifecycle
  // rule, which the worker leaves to the bucket rather than deleting by age
  // (see the header). The variable stays
  // documented and on the compose whitelist because it is the number the
  // operator sets that rule to.
  return {
    endpoint,
    bucket,
    accessKey,
    secretKey,
    region: envOr("BACKUP_S3_REGION", "auto"),
    encryptionKey: decodeBackupKey(encRaw),
    previousEncryptionKeys: (envValue("BACKUP_ENCRYPTION_PREVIOUS_KEYS") ?? "")
      .split(",")
      .map((raw) => raw.trim())
      .filter((raw) => raw.length > 0)
      .map(decodeBackupKey),
  };
}

/**
 * The envelope one off-host object is written in.
 *
 * Wire format (binary), by version byte:
 *   1: magic(4)="HLBK" || 0x01 || iv(12) || tag(16) || ciphertext(json)
 *   2: magic(4)="HLBK" || 0x02 || iv(12) || tag(16) || ciphertext(gzip(json))
 *   3: magic(4)="HLBK" || 0x03 || iv(12) || ciphertext(gzip(json)) || tag(16)
 *   4: magic(4)="HLBK" || 0x04 || keyIdLen(1) || keyId || iv(12)
 *        || ciphertext(gzip(json)) || tag(16), with the object's own key
 *        (`<date>/user-<id>.json.enc`) as GCM associated data
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
/**
 * Version 4 adds two things version 3 did not have, and changes nothing else.
 *
 * A key id: the first twelve hex characters of the key's SHA-256, so a reader
 * holding several keys (`BACKUP_ENCRYPTION_PREVIOUS_KEYS` during a rotation)
 * knows which one opens an object instead of trying each. It is a
 * fingerprint, not a name the operator has to keep in step.
 *
 * Associated data: the object's key in the bucket, which names the account
 * and the night. Before this, an object copied to another account's key in
 * the bucket, or to another date, decrypted as if it belonged there; now it
 * does not open at all.
 */
const BACKUP_ENVELOPE_KEYED = 0x04;
const OFFHOST_AAD_PREFIX = "healthlog/offhost-backup/v4|";
const MAGIC = "HLBK";
/** magic(4) + version(1). Where the per-version body begins. */
const PREAMBLE_LENGTH = 5;

/** The off-host keys a reader may use: the current one, then the retired. */
export interface OffhostKeyRing {
  active: Buffer;
  previous: Buffer[];
}

/** The key ring of a loaded configuration. */
export function offhostKeyRing(cfg: OffhostBackupConfig): OffhostKeyRing {
  return { active: cfg.encryptionKey, previous: cfg.previousEncryptionKeys };
}

function asKeyRing(key: Buffer | OffhostKeyRing): OffhostKeyRing {
  return Buffer.isBuffer(key) ? { active: key, previous: [] } : key;
}

/** The id a version-4 object records for the key it was written under. */
export function offhostKeyId(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 12);
}

function offhostAad(objectKey: string): Buffer {
  return Buffer.from(`${OFFHOST_AAD_PREFIX}${objectKey}`, "utf8");
}

/**
 * Open the gzip bytes of a version-4 object: find its key by id, verify the
 * tag with the object key as associated data.
 */
function openKeyed(
  buf: Buffer,
  ring: OffhostKeyRing,
  objectKey: string | undefined,
): Buffer {
  if (objectKey === undefined) {
    throw new Error(
      "This backup object is bound to its key in the bucket; pass the object key to open it",
    );
  }
  const idLen = buf[PREAMBLE_LENGTH];
  const keyId = buf
    .subarray(PREAMBLE_LENGTH + 1, PREAMBLE_LENGTH + 1 + idLen)
    .toString("latin1");
  const key = [ring.active, ...ring.previous].find(
    (candidate) => offhostKeyId(candidate) === keyId,
  );
  if (!key) {
    throw new Error(
      `Backup object was written under off-host key ${keyId}, which is neither BACKUP_ENCRYPTION_KEY nor in BACKUP_ENCRYPTION_PREVIOUS_KEYS`,
    );
  }
  return decryptRawStream(
    buf.subarray(PREAMBLE_LENGTH + 1 + idLen),
    key,
    offhostAad(objectKey),
  );
}

/**
 * Try each key of the ring on an object with no key id (versions 1 to 3),
 * current first. GCM refuses a wrong key outright, so the first key that
 * opens it is the one it was written under.
 */
function withEachKey<T>(ring: OffhostKeyRing, open: (key: Buffer) => T): T {
  let lastError: unknown = null;
  for (const key of [ring.active, ...ring.previous]) {
    try {
      return open(key);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError ?? new Error("No off-host key configured");
}

function isKnownVersion(version: number): boolean {
  return (
    version === BACKUP_ENVELOPE_PLAIN ||
    version === BACKUP_ENVELOPE_GZIP ||
    version === BACKUP_ENVELOPE_STREAM ||
    version === BACKUP_ENVELOPE_KEYED
  );
}

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

export function decryptBackup(
  buf: Buffer,
  keys: Buffer | OffhostKeyRing,
  objectKey?: string,
): string {
  const magic = buf.subarray(0, 4).toString("binary");
  const version = buf[PREAMBLE_LENGTH - 1];
  if (magic !== MAGIC || !isKnownVersion(version)) {
    throw new Error("Invalid backup envelope (bad magic or version)");
  }
  const ring = asKeyRing(keys);
  if (version === BACKUP_ENVELOPE_KEYED) {
    return gunzipSync(openKeyed(buf, ring, objectKey)).toString("utf8");
  }
  if (version === BACKUP_ENVELOPE_STREAM) {
    // iv | ciphertext | tag, exactly what the streaming writer emits and what
    // the shared reader verifies whole before it hands back a byte.
    const plaintext = withEachKey(ring, (key) =>
      decryptRawStream(buf.subarray(PREAMBLE_LENGTH), key),
    );
    return gunzipSync(plaintext).toString("utf8");
  }
  const plaintext = withEachKey(ring, (key) => openLeadingTag(buf, key));
  return version === BACKUP_ENVELOPE_GZIP
    ? gunzipSync(plaintext).toString("utf8")
    : plaintext.toString("utf8");
}

/** Versions 1 and 2: iv | tag | ciphertext. */
function openLeadingTag(buf: Buffer, key: Buffer): Buffer {
  const iv = buf.subarray(PREAMBLE_LENGTH, PREAMBLE_LENGTH + IV_LENGTH);
  const tag = buf.subarray(
    PREAMBLE_LENGTH + IV_LENGTH,
    PREAMBLE_LENGTH + IV_LENGTH + TAG_LENGTH,
  );
  const ct = buf.subarray(PREAMBLE_LENGTH + IV_LENGTH + TAG_LENGTH);
  const dec = createDecipheriv(ALGORITHM, key, iv);
  dec.setAuthTag(tag);
  return Buffer.concat([dec.update(ct), dec.final()]);
}

/**
 * An off-host object → a source of its JSON as byte chunks, openable as often
 * as needed. `decryptBackup` answers one string, which the JSON of a large
 * record cannot be: 662 MB for an account of 1.25 million measurements, past
 * the longest string V8 allows (#1031). The tag is verified whole on the
 * compressed ciphertext before a source exists, exactly as `decryptBackup`
 * does; only the decompression is streamed.
 */
export function openBackupObject(
  buf: Buffer,
  keys: Buffer | OffhostKeyRing,
  objectKey?: string,
): () => AsyncIterable<Buffer> {
  const magic = buf.subarray(0, 4).toString("binary");
  const version = buf[PREAMBLE_LENGTH - 1];
  if (magic !== MAGIC || !isKnownVersion(version)) {
    throw new Error("Invalid backup envelope (bad magic or version)");
  }
  const ring = asKeyRing(keys);
  let plaintext: Buffer;
  if (version === BACKUP_ENVELOPE_KEYED) {
    plaintext = openKeyed(buf, ring, objectKey);
  } else if (version === BACKUP_ENVELOPE_STREAM) {
    plaintext = withEachKey(ring, (key) =>
      decryptRawStream(buf.subarray(PREAMBLE_LENGTH), key),
    );
  } else {
    plaintext = withEachKey(ring, (key) => openLeadingTag(buf, key));
  }
  if (version === BACKUP_ENVELOPE_PLAIN) {
    return () => Readable.from([plaintext]);
  }
  return () => Readable.from([plaintext]).pipe(createGunzip());
}

/**
 * How much of one object the upload holds at a time, and how many of those
 * windows are in flight. `@aws-sdk/lib-storage` buffers `partSize` bytes per
 * queued part, so this pair — not the object — is the upload's footprint:
 * 16 MB, whatever the record turns out to be.
 */
const UPLOAD_PART_BYTES = 8 * 1024 * 1024;
const UPLOAD_CONCURRENCY = 2;

/** Pages of 1 000 keys one listing may walk: 200 000 objects. */
const MAX_LIST_PAGES = 200;

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
  objectKey: string,
  limitBytes: number,
): { stream: Transform; bytes: () => number } {
  const encryptor = createRawStreamEncryptor(key, offhostAad(objectKey));
  const keyId = Buffer.from(offhostKeyId(key), "latin1");
  const header = Buffer.concat([
    Buffer.from(MAGIC, "binary"),
    Buffer.from([BACKUP_ENVELOPE_KEYED, keyId.byteLength]),
    keyId,
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
    objectKey,
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
  /**
   * The bucket's lifecycle rule, as far as the credential may read it.
   * Optional so a test double that has no opinion leaves it out.
   */
  getLifecycle?(): Promise<OffhostLifecycle>;
}

/**
 * Whether the bucket retires old copies by itself.
 *
 * `configured` names the shortest expiry of an enabled rule; `missing` means
 * the bucket answered that it has no rule; `unknown` means it would not say
 * (a credential without `s3:GetLifecycleConfiguration`, a target that does not
 * implement the call, a network failure) and says nothing either way.
 */
export interface OffhostLifecycle {
  state: "configured" | "missing" | "unknown";
  expirationDays: number | null;
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
      // Every page, not the first. A bucket answers at most 1 000 keys per
      // call, in key order, so the first page of a bucket with a few accounts
      // and a month of retention holds only the OLDEST dates: the restore
      // drill read an old object and called the chain stale, and a purge
      // would have missed every newer copy. Bounded, so a bucket that holds
      // far more than this job put there cannot keep the loop going forever.
      const found: Array<{ key: string; lastModified?: Date }> = [];
      let token: string | undefined;
      for (let page = 0; page < MAX_LIST_PAGES; page++) {
        const out = await client.send(
          new mod.ListObjectsV2Command({
            Bucket: cfg.bucket,
            Prefix: prefix,
            ContinuationToken: token,
          }),
        );
        for (const c of out.Contents ?? []) {
          found.push({ key: c.Key ?? "", lastModified: c.LastModified });
        }
        if (!out.IsTruncated || !out.NextContinuationToken) return found;
        token = out.NextContinuationToken;
      }
      throw new Error(
        `Bucket listing under "${prefix}" did not end within ${MAX_LIST_PAGES} pages`,
      );
    },
    deleteObject: async (key) => {
      await client.send(
        new mod.DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }),
      );
    },
    getLifecycle: async () => {
      try {
        const out = await client.send(
          new mod.GetBucketLifecycleConfigurationCommand({
            Bucket: cfg.bucket,
          }),
          { abortSignal: AbortSignal.timeout(5_000) },
        );
        const days = (out.Rules ?? [])
          .filter((rule) => rule.Status === "Enabled")
          .map((rule) => rule.Expiration?.Days)
          .filter((d): d is number => typeof d === "number" && d > 0);
        return days.length > 0
          ? { state: "configured", expirationDays: Math.min(...days) }
          : { state: "missing", expirationDays: null };
      } catch (err) {
        const name = (err as { name?: string; Code?: string }).name;
        const code = (err as { Code?: string }).Code;
        if (
          name === "NoSuchLifecycleConfiguration" ||
          code === "NoSuchLifecycleConfiguration"
        ) {
          return { state: "missing", expirationDays: null };
        }
        return { state: "unknown", expirationDays: null };
      }
    },
  };
}

const LIFECYCLE_CACHE_MS = 10 * 60 * 1000;
let lifecycleCache: { at: number; value: OffhostLifecycle } | null = null;

/**
 * The bucket's lifecycle rule for the admin card, cached for ten minutes so a
 * page render does not become a bucket call. Never throws.
 */
export async function probeOffhostLifecycle(
  s3Override?: S3Like,
  now: number = Date.now(),
): Promise<OffhostLifecycle> {
  if (
    !s3Override &&
    lifecycleCache &&
    now - lifecycleCache.at < LIFECYCLE_CACHE_MS
  ) {
    return lifecycleCache.value;
  }
  const cfg = loadOffhostConfigSafe();
  if (!cfg) return { state: "unknown", expirationDays: null };
  let value: OffhostLifecycle;
  try {
    const s3 = s3Override ?? (await getS3Client(cfg));
    value = s3.getLifecycle
      ? await s3.getLifecycle()
      : { state: "unknown", expirationDays: null };
  } catch {
    value = { state: "unknown", expirationDays: null };
  }
  if (!s3Override) lifecycleCache = { at: now, value };
  return value;
}

/** `loadOffhostConfig`, answering null for a malformed key instead of throwing. */
function loadOffhostConfigSafe(): OffhostBackupConfig | null {
  try {
    return loadOffhostConfig();
  } catch {
    return null;
  }
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
  /**
   * Accounts an earlier attempt of the same run already uploaded, and this
   * one therefore skipped (see `RunOffhostBackupOptions.runStartedAt`).
   */
  alreadyUploaded: number;
  /** `shouldStop` ended the run before every account was reached. */
  stoppedEarly: boolean;
}

export interface RunOffhostBackupOptions extends UploadBackupOptions {
  /**
   * When this run first started: the pg-boss job's creation time, the same
   * on every attempt of the job. An attempt skips each account whose ledger
   * shows a successful upload since then, because an earlier attempt of the
   * same run already put its object in the bucket, and the objects are keyed
   * on this date so a retry after midnight still writes under the run's day.
   * Without it a retry started again from the first account (#1031), and on
   * a cohort with one large record the retry never got past the accounts the
   * first attempt had already done.
   */
  runStartedAt?: Date;
  /**
   * Asked before each account. Returning `true` ends the run cleanly between
   * accounts, before the job's expiry would cut one off halfway.
   */
  shouldStop?: () => boolean;
}

/**
 * Note, per key id, that an object needing it went into the bucket now. Never
 * fails the account: the object is in the bucket whatever this row says.
 */
async function recordOffhostKeyUse(
  prisma: PrismaClient,
  keyIds: readonly string[],
  at: Date,
): Promise<void> {
  for (const keyId of keyIds) {
    try {
      await prisma.offhostBackupKeyUse.upsert({
        where: { keyId },
        create: { keyId, firstWrittenAt: at, lastWrittenAt: at },
        update: { lastWrittenAt: at },
      });
    } catch (err) {
      getEvent()?.addWarning(
        `offhost-backup key-use write failed: ${(err as Error).message?.slice(0, 200)}`,
      );
    }
  }
}

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
  const runStartedAt = options.runStartedAt;
  // eslint-disable-next-line healthlog/no-utc-day-key -- UTC by design: off-host object key date, the name the restore drill and the purge look up
  const dateKey = (runStartedAt ?? now).toISOString().slice(0, 10);

  // By id, with an account whose last walk never came back behind the rest:
  // a record that killed the process once would otherwise lead every retry
  // and keep every account after it out of the bucket
  // (`backup-pass-attempts.ts`).
  const users = orderInterruptedLast(
    await prisma.user.findMany({
      select: { id: true },
      orderBy: { id: "asc" },
    }),
    await readInterruptedBackupAttempts(prisma, OFFHOST_BACKUP_QUEUE),
  );
  const doneThisRun = new Set<string>();
  if (runStartedAt) {
    const done = await prisma.offhostBackupState.findMany({
      where: { lastSuccessAt: { gte: runStartedAt } },
      select: { userId: true },
    });
    for (const row of done) doneThisRun.add(row.userId);
  }
  let alreadyUploaded = 0;
  let stoppedEarly = false;
  let uploaded = 0;
  let failed = 0;
  let oversized = 0;
  let largestObjectBytes = 0;
  const failures: Array<{ userId: string; message: string }> = [];
  let ledgerWriteFailures = 0;
  const evt = getEvent();
  for (const user of users) {
    if (doneThisRun.has(user.id)) {
      alreadyUploaded++;
      continue;
    }
    if (options.shouldStop?.()) {
      stoppedEarly = true;
      break;
    }
    let objectBytes: number | null = null;
    const objectKey = `${dateKey}/user-${user.id}.json.enc`;
    const accountStartedAt = new Date();
    // The key ids the object's content needs, read as it is written: the
    // admin encryption view uses them to say how long a retired key is still
    // needed for what is in the bucket.
    const keyScanner = createBackupKeyIdTextScanner();
    await markBackupAttemptStarted(
      prisma,
      OFFHOST_BACKUP_QUEUE,
      user.id,
      accountStartedAt,
    );
    try {
      objectBytes = await uploadEncryptedBackup(
        s3,
        objectKey,
        cfg.encryptionKey,
        // The same writer the weekly in-database pass uses. The payload
        // builder was always shared; everything after it was not, which is why
        // this job kept dying on a record the weekly one had learned to
        // survive.
        (write) =>
          streamFullBackupJson(
            prisma,
            user.id,
            async (chunk) => {
              keyScanner.feed(chunk);
              await write(chunk);
            },
            {
              purpose: "disaster-recovery",
              exportedAt: now,
            },
          ),
        options,
      );
      // The account was deleted or wiped while its copy was being written.
      // The purge that request started may already have run, so the copy
      // this run just put there is removed here rather than left behind.
      const purgedMeanwhile =
        (await prisma.offhostPurgeRequest.count({
          where: {
            subjectId: user.id,
            requestedAt: { gte: accountStartedAt },
          },
        })) > 0 || (await prisma.user.count({ where: { id: user.id } })) === 0;
      if (purgedMeanwhile) {
        await s3.deleteObject(objectKey);
        objectBytes = null;
        continue;
      }
      largestObjectBytes = Math.max(largestObjectBytes, objectBytes);
      uploaded++;
      await recordOffhostKeyUse(prisma, keyScanner.keyIds(), new Date());
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
    } finally {
      // Past this account, whatever the outcome: only a process that died
      // under it leaves the start without a finish.
      await markBackupAttemptFinished(prisma, OFFHOST_BACKUP_QUEUE, user.id);
    }

    // The per-account ledger, and deliberately NOT inside the upload's `try`.
    // `uploadEncryptedBackup` resolves only after the multipart completes, so
    // by here the object is durably in the bucket and this account's backup
    // has succeeded whatever the database does next. A pool timeout on the
    // row would otherwise un-count a copy that exists — the run would report
    // one failure too many and the console would read stale for an account
    // whose disaster-recovery object is fine, which is exactly the inversion
    // the ledger exists to remove.
    //
    // The row is written whether or not an object came of the walk, because a
    // ledger keyed only on success cannot tell "no run has reached this
    // account" from "a run reached it and nothing landed" — and the first of
    // those is what every account on a running host looks like the day this
    // table ships. A failed walk touches `lastAttemptAt` and leaves
    // `lastSuccessAt` exactly as it was, so yesterday's good copy still reads
    // as the copy this account has.
    //
    // `new Date()` rather than the run's `now`, because on a large cohort the
    // two are hours apart and the row is meant to say when this account was
    // reached.
    const at = new Date();
    try {
      await prisma.offhostBackupState.upsert({
        where: { userId: user.id },
        update:
          objectBytes === null
            ? { lastAttemptAt: at }
            : {
                lastAttemptAt: at,
                lastSuccessAt: at,
                sizeBytes: BigInt(objectBytes),
              },
        create:
          objectBytes === null
            ? { userId: user.id, lastAttemptAt: at }
            : {
                userId: user.id,
                lastAttemptAt: at,
                lastSuccessAt: at,
                sizeBytes: BigInt(objectBytes),
              },
      });
    } catch (err) {
      ledgerWriteFailures++;
      const message = (err as Error).message ?? "unknown";
      evt?.addWarning(
        `offhost-backup ledger write failed for ${user.id}: ${message.slice(0, 200)}`,
      );
    }
  }
  if (ledgerWriteFailures > 0) {
    // A distinct fact from a failed upload, and one an operator has to be able
    // to tell apart: the copies are in the bucket, the console's per-account
    // view of them is behind.
    annotate({ meta: { offhost_ledger_write_failures: ledgerWriteFailures } });
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
    alreadyUploaded,
    stoppedEarly,
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
