/**
 * The envelope a `DataBackup.data` row is stored in: compress, then encrypt.
 *
 * Why it exists. The weekly worker handed `encrypt(JSON.stringify(payload))`
 * straight to Postgres. For an account with a few hundred thousand
 * measurements that is four full copies of the record alive at the same
 * moment: the payload object graph, the JSON string, the base64 ciphertext at
 * 1.33× the JSON, and the copy the database driver makes of that parameter on
 * its way to the wire. Measured on a seeded 445 000-measurement account, the
 * JSON alone is 242 MB and the run dies of heap exhaustion — under a 1 GB heap
 * it never reaches the insert, and on a bigger heap it only reaches it later.
 * The weekly pass was not slow; it could not finish.
 *
 * Compressing first is what makes the whole tail of that pipeline cheap. A
 * health record's JSON is extremely repetitive — the same twenty keys per row,
 * timestamps sharing a prefix — so gzip takes that 242 MB to a few tens of
 * megabytes, and every copy after it shrinks with it. It is also the reason
 * the stored row stops being a liability of its own: the backup lives INSIDE
 * the database it would be needed to restore, so its size is not a cosmetic
 * concern.
 *
 * Compressing first was not enough on its own. Even with a small stored blob,
 * `packBackupBlob` still needs the whole JSON as one argument, and building
 * that string is what exhausts the heap — measured under
 * `--max-old-space-size=450` on the seeded account: `FATAL ERROR: Reached heap
 * limit`. So the writer the weekly job actually uses is
 * `packBackupBlobStreaming`, which never sees a complete copy of the JSON, the
 * gzip output or the ciphertext: rows go in a page at a time, gzip and the
 * cipher consume them as they arrive, and only the base64 answer accumulates,
 * because the destination is a single `text` column and one value is what the
 * column takes.
 *
 * Every direction reads. Three shapes exist in the wild and all three restore:
 * the original `encrypt(json)`, the compressed `encrypt("HLZ1:" + gz)`, and
 * the streamed `~hlgcm1.…` form written from now on. An operator whose newest
 * usable copy predates any of this is exactly the person who needs it to work.
 */
import { Buffer } from "node:buffer";
import v8 from "node:v8";
import { Readable } from "node:stream";
import { createGunzip, createGzip, gunzipSync, gzipSync } from "node:zlib";

import {
  createStreamEncryptor,
  decrypt,
  decryptStream,
  encrypt,
  isStreamCiphertext,
} from "@/lib/crypto";

/**
 * Prefix of the DECRYPTED plaintext when the body is gzipped-then-base64'd.
 * Chosen so it can never be mistaken for the alternative: a plain payload is
 * always a JSON object and therefore always starts with `{`.
 */
const GZIP_MARKER = "HLZ1:";

/** Serialised backup JSON → the string stored in `DataBackup.data`. */
export function packBackupBlob(json: string): string {
  const compressed = gzipSync(json).toString("base64");
  return encrypt(`${GZIP_MARKER}${compressed}`);
}

/**
 * The share of this process's heap limit one stored backup may become.
 *
 * The blob is the single copy this pipeline cannot stream away:
 * `data_backups.data` is one `text` column, so the row has to be one value,
 * and the driver makes a second copy of it on its way to the wire. Two copies
 * of the answer plus whatever the process legitimately holds is what has to
 * fit at once, so a fifth of the heap limit is one account's share.
 *
 * It is a share of the LIMIT, not of what is currently used. How large a
 * single value this process can hold depends on how it was started; it does
 * not depend on how long it has been running or on how much garbage is
 * waiting to be collected. The check this replaced read the latter, and so
 * aborted a 1.2 MB record on a server that had merely been up for a week.
 */
const BLOB_HEAP_SHARE = 0.2;

/** Bytes as an operator reads them. Kilobytes below a megabyte. */
function size(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return mb < 100 ? `${mb.toFixed(1)} MB` : `${Math.round(mb)} MB`;
}

/** Default cap for one stored blob, in bytes. */
export function defaultBackupBlobLimit(): number {
  return Math.floor(v8.getHeapStatistics().heap_size_limit * BLOB_HEAP_SHARE);
}

/**
 * Thrown when one account's encrypted backup outgrows what this process can
 * hold as a single value.
 *
 * The message states what was counted — the ciphertext written so far — and
 * the limit it crossed, because that is the pair an operator can act on. It
 * is about the record, and it is true: raising the heap raises the limit with
 * it, since the limit is derived from the heap.
 */
export class BackupBlobTooLargeError extends Error {
  readonly bytes: number;
  readonly limitBytes: number;

  constructor(bytes: number, limitBytes: number) {
    super(
      `Backup stopped after ${size(bytes)} of encrypted backup for one ` +
        `account, over the ${size(limitBytes)} a single stored copy may ` +
        `occupy here (a fifth of this process's ` +
        `${size(v8.getHeapStatistics().heap_size_limit)} heap limit). This ` +
        `account's record is genuinely too large to store as one row on this ` +
        `host; raise the container's memory or NODE_OPTIONS=` +
        `--max-old-space-size and the limit rises with it.`,
    );
    this.name = "BackupBlobTooLargeError";
    this.bytes = bytes;
    this.limitBytes = limitBytes;
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

export interface PackBackupBlobOptions {
  /**
   * Largest stored blob this call may produce, in bytes. Defaults to
   * `defaultBackupBlobLimit()`. Tests pass an explicit value; nothing else
   * should need to.
   */
  maxBytes?: number;
}

/**
 * Serialised backup JSON, produced in pieces → the stored string.
 *
 * The pipeline is JSON piece → gzip → AES-256-GCM → base64, with nothing
 * buffered end to end but the base64 answer. Kept for callers that need the
 * answer as one value; the weekly and manual backup no longer do, they hand
 * the pieces to Postgres as they come (`packBackupBlobInto` below, via
 * `storeBackupBlob`).
 */
export async function packBackupBlobStreaming(
  producer: BackupJsonProducer,
  options: PackBackupBlobOptions = {},
): Promise<string> {
  const pieces: string[] = [];
  await packBackupBlobInto(
    (piece) => {
      pieces.push(piece);
    },
    producer,
    options,
  );
  return pieces.join("");
}

/** Receives the stored string a piece at a time, in order. Awaited. */
export type BackupBlobSink = (piece: string) => void | Promise<void>;

/**
 * How much base64 to gather before handing it to the sink. Large enough that
 * a sink writing to the database makes a few dozen round trips for a large
 * record rather than thousands, small enough to be irrelevant to the heap.
 */
const SINK_FLUSH_BYTES = 4 * 1024 * 1024;

/**
 * Serialised backup JSON, produced in pieces → the stored string, delivered
 * in pieces.
 *
 * The concatenation of every piece `sink` receives is exactly the string
 * `packBackupBlobStreaming` returns. `producer` decides how big its JSON
 * pieces are; the gzip stream applies backpressure through the promise this
 * hands back, so a fast producer cannot outrun the compressor, and a slow
 * sink holds the producer back the same way, so neither side piles up.
 *
 * `maxBytes` still counts the whole answer. Nothing here holds it any more,
 * but every reader of a stored copy (restore, download, summary) opens it as
 * one value, so the limit is what keeps a copy restorable on this host.
 */
export async function packBackupBlobInto(
  sink: BackupBlobSink,
  producer: BackupJsonProducer,
  options: PackBackupBlobOptions = {},
): Promise<void> {
  const limitBytes = options.maxBytes ?? defaultBackupBlobLimit();
  const encryptor = createStreamEncryptor();
  let pending: string[] = [encryptor.header];
  let pendingBytes = encryptor.header.length;
  let heldBytes = encryptor.header.length;
  const gzip = createGzip();

  let failure: unknown = null;
  gzip.on("data", (chunk: Buffer) => {
    try {
      const piece = encryptor.update(chunk);
      if (piece === "") return;
      // Base64 is ASCII, so a character counted here is a byte written here.
      heldBytes += piece.length;
      if (heldBytes > limitBytes) {
        throw new BackupBlobTooLargeError(heldBytes, limitBytes);
      }
      pending.push(piece);
      pendingBytes += piece.length;
    } catch (err) {
      failure ??= err;
      gzip.destroy(err as Error);
    }
  });

  const finished = new Promise<void>((resolve, reject) => {
    gzip.on("end", resolve);
    gzip.on("error", reject);
  });
  // A failure raised inside the `data` handler destroys the stream, which
  // rejects this promise — and the producer's own `write` rethrows the same
  // failure first, so nothing ever awaits it. Marking it handled keeps a
  // failure that IS being reported from also surfacing as an unhandled
  // rejection; `await finished` below still sees the rejection.
  finished.catch(() => {});

  const flush = async (force: boolean): Promise<void> => {
    if (pendingBytes === 0 || (!force && pendingBytes < SINK_FLUSH_BYTES)) {
      return;
    }
    const piece = pending.join("");
    pending = [];
    pendingBytes = 0;
    await sink(piece);
  };

  const write = async (chunk: string | Buffer): Promise<void> => {
    if (failure) throw failure;
    await flush(false);
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
  if (failure) throw failure;

  const tail = encryptor.final();
  pending.push(tail);
  pendingBytes += tail.length;
  await flush(true);
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
