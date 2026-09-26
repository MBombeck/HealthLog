/**
 * The sealed form of one piece of a stored backup (`data_backup_chunks.data`).
 *
 * Why pieces. A stored backup used to be one value in one row, and one value
 * has to pass through this process whole on its way in and out: the driver
 * binds it as one parameter and returns it as one string. So the largest copy
 * a host could keep was a share of the heap, 105 MB in the default 1 GB
 * container, and an account with 1.75 million readings was past it (#1031).
 * Stored as ordered pieces of about a megabyte, a copy of any size passes
 * through a piece at a time.
 *
 * Why each piece is sealed on its own. The copy used to be one AES-256-GCM
 * stream with the tag at the end, which authenticates the whole only once the
 * whole has been read; checking it before releasing a byte meant holding every
 * byte, which is the thing pieces are meant to avoid. Sealing every piece
 * separately lets the reader check each one before it passes it on. On its own
 * that would authenticate the pieces but not their order or their number, so
 * the sealed plaintext of every piece starts with a header that says which
 * copy it belongs to, where it goes and whether it is the last:
 *
 *   "HLBC" | version 0x01 | streamId (16 bytes) | seq (u32 BE) | flags (u8) | payload
 *
 * `streamId` is random per written copy, so a piece from an earlier copy or
 * from another account's copy is refused; `seq` pins the position, so a piece
 * moved or dropped is refused; the last-piece flag, set on exactly one piece,
 * is what a reader needs to tell a complete copy from one cut short. That is
 * the construction known as STREAM (Hoang, Reyhanitabar, Rogaway, Vizár 2015),
 * with the position and the flag carried inside the authenticated plaintext
 * rather than in the nonce. Every piece has its own random 96-bit IV.
 *
 * Every piece is sealed with a fixed associated-data label
 * (`BACKUP_CHUNK_AAD`), so a value the same key sealed for another purpose
 * never opens as a backup piece.
 *
 * The header sits inside the ciphertext rather than beside it, deliberately:
 * key rotation re-seals a piece without knowing what it holds
 * (`reencryptBytesToActive`, given the same fixed label), and the binding
 * survives that untouched. A position or stream id held as associated data
 * would differ per piece, and rotation would need to know it for each one.
 *
 * The payload is gzip output. The pieces of one copy, opened in order and
 * concatenated, are one gzip stream of the backup JSON.
 */
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";

import { decryptBytes, encryptBytes } from "@/lib/crypto";
import { BACKUP_CHUNK_AAD } from "@/lib/crypto/encrypted-columns";

const MAGIC = Buffer.from("HLBC", "ascii");
const VERSION = 0x01;
const STREAM_ID_BYTES = 16;
const FLAG_LAST = 0x01;
const HEADER_BYTES = MAGIC.byteLength + 1 + STREAM_ID_BYTES + 4 + 1;

/**
 * How much compressed backup one piece carries. Large enough that a big copy
 * is a few hundred rows rather than tens of thousands, small enough that a
 * reader or the key rotation holding a batch of pieces is a few tens of
 * megabytes whatever the account.
 */
export const BACKUP_CHUNK_BYTES = 1024 * 1024;

/**
 * A stored copy whose pieces do not add up to the copy that was written: a
 * piece missing, moved, altered, taken from another copy, or the last one
 * gone. Also what a piece that will not decrypt is reported as, since the
 * reader cannot tell a dropped key from altered bytes and the operator's next
 * step is the same.
 */
export class BackupIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupIntegrityError";
  }
}

/** A fresh stream id for one written copy, as the hex the row stores. */
export function newChunkStreamId(): string {
  return randomBytes(STREAM_ID_BYTES).toString("hex");
}

function streamIdBytes(streamId: string): Buffer {
  if (!/^[0-9a-f]{32}$/.test(streamId)) {
    throw new BackupIntegrityError("The stored copy's stream id is malformed.");
  }
  return Buffer.from(streamId, "hex");
}

/** Seal one piece of the copy `streamId` at position `seq`. */
export function sealBackupChunk(
  streamId: string,
  seq: number,
  last: boolean,
  payload: Buffer,
): Buffer {
  const header = Buffer.alloc(HEADER_BYTES);
  let at = MAGIC.copy(header, 0);
  header[at++] = VERSION;
  at += streamIdBytes(streamId).copy(header, at);
  header.writeUInt32BE(seq, at);
  at += 4;
  header[at] = last ? FLAG_LAST : 0;
  return encryptBytes(Buffer.concat([header, payload]), BACKUP_CHUNK_AAD);
}

export interface ExpectedChunk {
  streamId: string;
  seq: number;
  /** Whether this position is the copy's last, from the row's piece count. */
  last: boolean;
}

/**
 * Authenticate one sealed piece and check it is the piece expected at this
 * position of this copy. Returns its payload; throws `BackupIntegrityError`
 * for anything else, before any of the payload is released.
 */
export function openBackupChunk(
  sealed: Uint8Array,
  expected: ExpectedChunk,
): Buffer {
  let plain: Buffer;
  try {
    plain = decryptBytes(Buffer.from(sealed), BACKUP_CHUNK_AAD);
  } catch (err) {
    throw new BackupIntegrityError(
      `Piece ${expected.seq} of the stored copy could not be decrypted: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (
    plain.byteLength < HEADER_BYTES ||
    !plain.subarray(0, MAGIC.byteLength).equals(MAGIC) ||
    plain[MAGIC.byteLength] !== VERSION
  ) {
    throw new BackupIntegrityError(
      `Piece ${expected.seq} of the stored copy is not a backup piece.`,
    );
  }
  let at = MAGIC.byteLength + 1;
  const streamId = plain.subarray(at, at + STREAM_ID_BYTES);
  at += STREAM_ID_BYTES;
  const seq = plain.readUInt32BE(at);
  at += 4;
  const last = (plain[at]! & FLAG_LAST) !== 0;

  if (!streamId.equals(streamIdBytes(expected.streamId))) {
    throw new BackupIntegrityError(
      `Piece ${expected.seq} belongs to a different stored copy.`,
    );
  }
  if (seq !== expected.seq) {
    throw new BackupIntegrityError(
      `The piece stored at position ${expected.seq} was written as piece ${seq}.`,
    );
  }
  if (last !== expected.last) {
    throw new BackupIntegrityError(
      last
        ? `Piece ${seq} was written as the last, but the copy lists more.`
        : `Piece ${seq} is the last the copy lists, but more were written.`,
    );
  }
  return plain.subarray(HEADER_BYTES);
}
