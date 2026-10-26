/**
 * The off-host backup key as a value: how the operator writes it and the id
 * an object records for it. Kept apart from the uploader so the recovery kit
 * can name the keys without loading the backup machinery.
 */
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

/** One off-host key as the operator writes it: 64 hex or 32-byte base64. */
export function decodeBackupKey(raw: string): Buffer {
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
 * The id a version-4 object records for the key it was written under: the
 * first twelve hex characters of the key's SHA-256. The recovery kit uses the
 * same value as the key's fingerprint, so a kit entry matches an object header.
 */
export function offhostKeyId(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 12);
}
