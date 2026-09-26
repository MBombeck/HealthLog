/**
 * The envelope of a stored backup: compress, then encrypt.
 *
 * Why compress. A health record's JSON is extremely repetitive (the same
 * twenty keys per row, timestamps sharing a prefix), so gzip takes it to about
 * a tenth, and every copy after that shrinks with it. The backup also lives
 * inside the database it would be needed to restore, so its size matters.
 *
 * How it is written. The JSON goes into gzip a page at a time, and gzip's
 * output is sealed in pieces of about a megabyte (`packBackupChunks`, the
 * piece format in `backup-chunks.ts`), which `storeBackupBlob` puts into
 * `data_backup_chunks`. Nothing in this process ever holds the whole JSON,
 * the whole compressed copy or the whole ciphertext, so the size of a copy
 * does not depend on the memory of the process that writes or reads it.
 *
 * Every earlier form still reads. Up to v1.39.1 a copy was one value in
 * `data_backups.data`, in one of three shapes: the original `encrypt(json)`,
 * the compressed `encrypt("HLZ1:" + gz)`, and the streamed `~hlgcm1.…` form.
 * `openBackupBlob` below opens all three; an operator whose newest usable copy
 * predates the pieces is exactly the person who needs it to work.
 */
import { Buffer } from "node:buffer";
import { Readable } from "node:stream";
import { createGunzip, createGzip, gunzipSync, gzipSync } from "node:zlib";

import {
  decrypt,
  decryptStream,
  encrypt,
  isStreamCiphertext,
} from "@/lib/crypto";
import {
  sealBackupChunk,
  BACKUP_CHUNK_BYTES,
} from "@/lib/export/backup-chunks";

/**
 * Prefix of the DECRYPTED plaintext when the body is gzipped-then-base64'd.
 * Chosen so it can never be mistaken for the alternative: a plain payload is
 * always a JSON object and therefore always starts with `{`.
 */
const GZIP_MARKER = "HLZ1:";

/**
 * Serialised backup JSON → the single-value form stored in `DataBackup.data`
 * before v1.39.2. Nothing in the app writes it any more; the tests use it to
 * stand in for a copy written by an earlier release.
 */
export function packBackupBlob(json: string): string {
  const compressed = gzipSync(json).toString("base64");
  return encrypt(`${GZIP_MARKER}${compressed}`);
}

/** Bytes as an operator reads them. Kilobytes below a megabyte. */
function size(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return mb < 100 ? `${mb.toFixed(1)} MB` : `${Math.round(mb)} MB`;
}

/**
 * The largest stored copy of one account, in megabytes, unless the operator
 * sets `BACKUP_MAX_STORED_MB`.
 *
 * Not a memory bound. A copy is written and read a piece at a time
 * (`backup-chunks.ts`), so its size does not depend on the process; the only
 * thing it takes is room in the database, which holds the old and the new
 * copy side by side until the new one commits. The limit is there so a
 * runaway copy stops with a message instead of filling the database volume.
 * 2 GB is far past any record seen so far: the copy of an account with 2.6
 * million readings is about 100 MB.
 */
const DEFAULT_MAX_STORED_MB = 2048;

/** The stored-copy limit in bytes: `BACKUP_MAX_STORED_MB`, or the default. */
export function defaultBackupStoreLimit(): number {
  const raw = process.env.BACKUP_MAX_STORED_MB?.trim();
  const mb = raw ? Number(raw) : NaN;
  const effective = Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_MAX_STORED_MB;
  return Math.floor(effective * 1024 * 1024);
}

/** The stable code of the 413 an upload too large to store is answered with. */
export const BACKUP_UPLOAD_TOO_LARGE_CODE = "backup.upload.too_large";

/**
 * Thrown when one account's encrypted copy passes the stored-copy limit.
 *
 * The message names what was counted, the limit it crossed, where the limit
 * comes from and what to do about it, because that is what an operator reading
 * a failed job needs. Nothing was stored: the write is one transaction, so the
 * previous copy is still in place.
 */
export class BackupBlobTooLargeError extends Error {
  readonly bytes: number;
  readonly limitBytes: number;

  constructor(bytes: number, limitBytes: number) {
    super(
      `Backup stopped after ${size(bytes)} of encrypted backup for one ` +
        `account, over the ${size(limitBytes)} limit for one stored copy ` +
        `(BACKUP_MAX_STORED_MB, default ${DEFAULT_MAX_STORED_MB}). The ` +
        `previous copy is unchanged. To store a copy this size, set ` +
        `BACKUP_MAX_STORED_MB in .env to a larger number of megabytes and ` +
        `recreate the app container; the database needs room for two copies ` +
        `of this size while the new one is written.`,
    );
    this.name = "BackupBlobTooLargeError";
    this.bytes = bytes;
    this.limitBytes = limitBytes;
  }
}

/**
 * Thrown when the copy a store would replace is being restored: a restore of
 * it is queued or running. Replacing it then would pull the pieces out from
 * under the restore. Nothing was written; the weekly run tries again next
 * time.
 */
export class BackupBusyError extends Error {
  constructor(readonly backupId: string) {
    super(
      "Backup not replaced: a restore of the current copy is queued or " +
        "running. The previous copy is unchanged; the next run replaces it.",
    );
    this.name = "BackupBusyError";
  }
}

/**
 * Produces the backup JSON in pieces. Every piece is written in order.
 *
 * Whatever it resolves to is ignored — the writer's own return value (the row
 * counts) is the caller's business, not the envelope's.
 */
export type BackupJsonProducer = (
  write: (chunk: string | Buffer) => Promise<void>,
) => Promise<unknown>;

export interface PackBackupOptions {
  /**
   * Largest stored copy this call may produce, in bytes. Defaults to
   * `defaultBackupStoreLimit()`. Tests pass an explicit value; nothing else
   * should need to.
   */
  maxBytes?: number;
  /**
   * How much compressed backup one piece carries. Defaults to
   * `BACKUP_CHUNK_BYTES`; tests lower it so a small record spans many pieces.
   */
  chunkBytes?: number;
}

/**
 * Receives each sealed piece of the copy, in order, with its position.
 * Awaited, so a slow destination holds the producer back.
 */
export type BackupChunkSink = (sealed: Buffer, seq: number) => Promise<void>;

/**
 * Collects gzip output and seals it into pieces of about `chunkBytes`, in
 * order, counting the stored bytes against the limit. `finish` seals what is
 * left as the last piece, even when that is nothing, because the last-piece
 * mark is what tells a reader the copy is complete.
 */
function chunkSealer(
  sink: BackupChunkSink,
  streamId: string,
  options: PackBackupOptions,
) {
  const limitBytes = options.maxBytes ?? defaultBackupStoreLimit();
  const chunkBytes = options.chunkBytes ?? BACKUP_CHUNK_BYTES;
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let seq = 0;
  let stored = 0;

  const seal = async (last: boolean): Promise<void> => {
    const payload = pending.length === 1 ? pending[0]! : Buffer.concat(pending);
    pending = [];
    pendingBytes = 0;
    const sealed = sealBackupChunk(streamId, seq, last, payload);
    stored += sealed.byteLength;
    if (stored > limitBytes) {
      throw new BackupBlobTooLargeError(stored, limitBytes);
    }
    await sink(sealed, seq);
    seq += 1;
  };

  return {
    push(gz: Buffer): void {
      pending.push(gz);
      pendingBytes += gz.byteLength;
    },
    async flushFull(): Promise<void> {
      while (pendingBytes >= chunkBytes) await seal(false);
    },
    async finish(): Promise<{ chunks: number; bytes: number }> {
      while (pendingBytes >= chunkBytes) await seal(false);
      await seal(true);
      return { chunks: seq, bytes: stored };
    },
  };
}

/**
 * Serialised backup JSON, produced in pieces → sealed pieces of the stored
 * copy, handed to `sink` as they fill.
 *
 * The pipeline is JSON piece → gzip → a piece of about `BACKUP_CHUNK_BYTES`
 * → AES-256-GCM (`sealBackupChunk`). Nothing is held but the piece being
 * filled: the gzip stream applies backpressure through the promise `write`
 * hands back, and a full piece is sealed and sunk before the producer may
 * write again.
 */
export async function packBackupChunks(
  sink: BackupChunkSink,
  streamId: string,
  producer: BackupJsonProducer,
  options: PackBackupOptions = {},
): Promise<{ chunks: number; bytes: number }> {
  const sealer = chunkSealer(sink, streamId, options);
  const gzip = createGzip();
  gzip.on("data", (chunk: Buffer) => sealer.push(chunk));
  const finished = new Promise<void>((resolve, reject) => {
    gzip.on("end", resolve);
    gzip.on("error", reject);
  });
  // The producer's own failure is what gets reported; this only keeps the
  // same rejection from also surfacing as unhandled. `await finished` below
  // still sees it.
  finished.catch(() => {});

  const write = async (chunk: string | Buffer): Promise<void> => {
    await sealer.flushFull();
    if (gzip.write(chunk, "utf8")) return;
    await new Promise<void>((resolve, reject) => {
      const onDrain = () => {
        gzip.off("error", onError);
        resolve();
      };
      const onError = (err: Error) => {
        gzip.off("drain", onDrain);
        reject(err);
      };
      gzip.once("drain", onDrain);
      gzip.once("error", onError);
    });
  };

  try {
    await producer(write);
  } catch (err) {
    gzip.destroy();
    throw err;
  }
  gzip.end();
  await finished;
  return sealer.finish();
}

/**
 * Bytes that are already one gzip stream of the backup JSON → sealed pieces.
 * For converting a copy stored before v1.39.2, whose content is gzip output
 * already and needs no second compression.
 */
export async function packGzipChunks(
  sink: BackupChunkSink,
  streamId: string,
  gz: AsyncIterable<Buffer> | Iterable<Buffer>,
  options: PackBackupOptions = {},
): Promise<{ chunks: number; bytes: number }> {
  const sealer = chunkSealer(sink, streamId, options);
  for await (const piece of gz) {
    sealer.push(piece);
    await sealer.flushFull();
  }
  return sealer.finish();
}

/**
 * The refusal a caller gets when a stored copy will not open, as one string.
 *
 * Two causes, one answer, because the envelope cannot tell them apart and the
 * operator's next step is the same either way: the key that wrote the copy is
 * no longer in `ENCRYPTION_KEYS` (a rotation that dropped the legacy entry too
 * early — the case `docs/ops/encryption-key-rotation.md` warns about), or the
 * stored bytes are not the bytes that were written. Neither is a server fault,
 * so neither is a 500: it is bad stored input, refused with 422 like every
 * other bad input on these routes, and it never reaches the error reporter as
 * if the process had broken.
 *
 * Shared rather than retyped, so the three routes that decrypt a stored copy —
 * restore, download, summary — cannot drift into three different sentences for
 * the same condition.
 */
export const BACKUP_UNDECRYPTABLE_ERROR =
  "Backup payload could not be decrypted — either the key that wrote this copy is no longer in ENCRYPTION_KEYS, or the stored copy is not the one that was written. Nothing was changed.";

/** The stable machine-readable half of {@link BACKUP_UNDECRYPTABLE_ERROR}. */
export const BACKUP_UNDECRYPTABLE_CODE = "backup.payload.undecryptable";

/**
 * A stored `DataBackup.data` string → the backup JSON.
 *
 * Fails closed on every arm: a bad key, a mangled ciphertext, a tag that does
 * not verify or a truncated gzip member throws rather than returning a partial
 * document, because every caller goes on to parse the result as a whole
 * account.
 */
export function unpackBackupBlob(stored: string): string {
  // Streamed form. Always gzipped — the streaming writer has no other mode —
  // and the tag is verified over the whole ciphertext before a byte of this
  // is unpacked.
  if (isStreamCiphertext(stored)) {
    return gunzipSync(decryptStream(stored)).toString("utf8");
  }
  const plaintext = decrypt(stored);
  if (!plaintext.startsWith(GZIP_MARKER)) return plaintext;
  return gunzipSync(
    Buffer.from(plaintext.slice(GZIP_MARKER.length), "base64"),
  ).toString("utf8");
}

/**
 * A single-value copy in one of the two forms written from one string (plain
 * `encrypt(json)` or `HLZ1:` gzip) → its content as gzip bytes, for the
 * conversion into pieces. The `~hlgcm1.` stream form is read in slices instead.
 */
export function singleValueToGzip(stored: string): Buffer {
  const plaintext = decrypt(stored);
  if (plaintext.startsWith(GZIP_MARKER)) {
    return Buffer.from(plaintext.slice(GZIP_MARKER.length), "base64");
  }
  return gzipSync(plaintext);
}

/**
 * A stored `DataBackup.data` string → a source of its JSON as byte chunks,
 * which can be opened as many times as the caller needs to read it.
 *
 * `unpackBackupBlob` returns the JSON as one string, and a string is what a
 * large record cannot be: the disaster-recovery JSON of an account with 1.25
 * million measurements is 662 MB, past the 536 870 888 characters V8 allows
 * in any string, so that call threw on every such backup (#1031). Here the
 * authentication happens first and whole, on the compressed ciphertext, which
 * stays small (48 MB for that record): no plaintext byte is released before
 * the tag has verified. Only the decompression is streamed, on every open.
 *
 * Fail-closed exactly like `unpackBackupBlob`: a bad key or a tag that does
 * not verify throws here, before a source exists; a truncated gzip member
 * errors the stream.
 */
export function openBackupBlob(stored: string): () => AsyncIterable<Buffer> {
  if (isStreamCiphertext(stored)) {
    const gz = decryptStream(stored);
    return () => Readable.from([gz]).pipe(createGunzip());
  }
  const plaintext = decrypt(stored);
  if (!plaintext.startsWith(GZIP_MARKER)) {
    // A pre-envelope copy was written from one string, so it is one.
    const bytes = Buffer.from(plaintext, "utf8");
    return () => Readable.from([bytes]);
  }
  const gz = Buffer.from(plaintext.slice(GZIP_MARKER.length), "base64");
  return () => Readable.from([gz]).pipe(createGunzip());
}
