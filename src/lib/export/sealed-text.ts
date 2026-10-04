/**
 * Both ends of a sealed free-text column in a backup section: the string
 * codec (`<keyId>.<base64>` in a text column — the cycle day-log note and
 * sensitive envelope, custom cycle symptom and mood labels) and the shared
 * bytes codec (the practitioner note, the visit's reason, outcome and body
 * site, the vaccination note).
 *
 * The split is the one every other section uses. A disaster-recovery file
 * carries the stored ciphertext, which the same instance's key reads back. A
 * portable file carries the readable value (or the unreadable marker when
 * the writing host could not open it), and the restore seals it under the
 * receiving host's active key, because ciphertext from one host is noise on
 * another.
 *
 * Portable files written before v1.40 carried these columns as ciphertext.
 * They still restore: a ciphertext value is written back only when this
 * host's keys open it. One that does not open is kept out of the row and its
 * file path is recorded, so the caller can name it in the skip report rather
 * than store a value nobody can read. That per-value check is why the key
 * preflight leaves these sections out (`RESTORE_SELF_VERIFIED_SECTIONS`).
 */
import { Buffer } from "node:buffer";

import { decryptFromBytes, encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import { decrypt, encrypt } from "@/lib/crypto";
import { UNREADABLE_EXPORT_MARKER } from "@/lib/export/unreadable-marker";
import { getEvent } from "@/lib/logging/context";

/** Open a sealed value for a portable file, or the unreadable marker. */
export function openSealedForExport(sealed: string, field: string): string {
  try {
    return decrypt(sealed);
  } catch (err) {
    getEvent()?.addWarning(
      `${field} decrypt failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return UNREADABLE_EXPORT_MARKER;
  }
}

/** A readable value the file could not supply: the writer could not open it. */
export const UNOPENED: unique symbol = Symbol("unopened");

/**
 * The sealed column value for one free-text field from the file.
 *
 * Ciphertext is written back only when this host opens it — a value sealed
 * under a key this host does not hold (or the same key id over other key
 * material) would be a row nobody can read. A readable value is sealed under
 * this host's active key. Anything kept out is recorded under `path`.
 */
export function sealForRestore(
  sealed: string | null | undefined,
  readable: string | null | undefined | typeof UNOPENED,
  path: string,
  unopened: string[],
): string | null {
  if (sealed) {
    try {
      decrypt(sealed);
      return sealed;
    } catch {
      unopened.push(path);
      return null;
    }
  }
  if (readable === UNOPENED) {
    unopened.push(path);
    return null;
  }
  return readable ? encrypt(readable) : null;
}

/**
 * The `Bytes` twin of {@link openSealedForExport}, for columns written with
 * the shared bytes codec (`encryptToBytes`): the practitioner note, the
 * visit's reason, outcome and body site, the vaccination note.
 */
export function openSealedBytesForExport(
  sealed: Uint8Array | null,
  field: string,
): string | null {
  if (!sealed || sealed.byteLength === 0) return null;
  try {
    return decryptFromBytes(sealed);
  } catch (err) {
    getEvent()?.addWarning(
      `${field} decrypt failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return UNREADABLE_EXPORT_MARKER;
  }
}

/** The stored `Bytes` ciphertext as a disaster-recovery file carries it. */
export function encodeSealedBytes(value: Uint8Array | null): string | null {
  if (!value || value.byteLength === 0) return null;
  return Buffer.from(value).toString("base64");
}

function decodeBase64(encoded: string): Uint8Array<ArrayBuffer> {
  const decoded = Buffer.from(encoded, "base64");
  const bytes = new Uint8Array(new ArrayBuffer(decoded.byteLength));
  bytes.set(decoded);
  return bytes;
}

/**
 * The `Bytes` twin of {@link sealForRestore}. `sealed` is the base64 a
 * disaster-recovery (or pre-v1.40 portable) file carries; it is written back
 * only when this host opens it. A readable value is sealed under this host's
 * active key.
 */
export function sealBytesForRestore(
  sealed: string | null | undefined,
  readable: string | null | undefined,
  path: string,
  unopened: string[],
): Uint8Array<ArrayBuffer> | null {
  if (sealed) {
    const bytes = decodeBase64(sealed);
    try {
      decryptFromBytes(bytes);
      return bytes;
    } catch {
      unopened.push(path);
      return null;
    }
  }
  return readable ? encryptToBytes(readable) : null;
}
