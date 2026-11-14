/**
 * #1371 — the person's own note on a medication ("30 to 60 minutes before
 * food"), sealed at rest in `Medication.noteEncrypted`.
 *
 * One read and one write boundary, so every reader serves the same decrypted
 * `note` and no reader hands the ciphertext column to a client. There is no
 * plaintext column and no legacy fallback: the column was sealed from its
 * first write. A present ciphertext that does not decrypt throws (fail-closed),
 * like every other sealed column.
 */
import { decryptFromBytes } from "@/lib/ai/coach/bytes-codec";
import { encryptNote } from "@/lib/crypto/note-cipher";

/**
 * The column value for a note from a request: `undefined` leaves the stored
 * note untouched, NULL or a blank string clears it, anything else is trimmed
 * and sealed.
 */
export function sealMedicationNote(
  note: string | null | undefined,
): Uint8Array<ArrayBuffer> | null | undefined {
  if (note === undefined) return undefined;
  return encryptNote(note === null ? null : note.trim());
}

/** The stored note, decrypted; NULL when there is none. */
export function readMedicationNote(
  sealed: Uint8Array | null | undefined,
): string | null {
  return sealed ? decryptFromBytes(sealed) : null;
}

/**
 * A medication row as it may leave the server: the ciphertext column removed
 * and the decrypted note beside the other columns as `note`.
 */
export function withMedicationNote<
  T extends { noteEncrypted: Uint8Array | null },
>(row: T): Omit<T, "noteEncrypted"> & { note: string | null } {
  const { noteEncrypted, ...rest } = row;
  return { ...rest, note: readMedicationNote(noteEncrypted) };
}
