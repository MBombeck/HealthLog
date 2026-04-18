/**
 * AES-256-GCM encryption for sensitive data at rest.
 * Used for Withings OAuth tokens and other secrets.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { getEvent } from "@/lib/logging/context";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function getKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) {
    throw new Error("ENCRYPTION_KEY env var must be set");
  }

  // Require a proper 64-char hex string (= 32 bytes = 256 bits)
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, "hex");
  }

  // Accept shorter hex keys (>= 32 chars) for dev convenience only.
  // In production this is a hard failure — a short key materially weakens
  // the AES-256-GCM guarantee even with SHA-256 padding.
  if (/^[0-9a-fA-F]+$/.test(raw) && raw.length >= 32) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        `ENCRYPTION_KEY must be exactly 64 hex characters (256 bits) in production. Current length: ${raw.length}. Generate one with: openssl rand -hex 32`,
      );
    }
    // Dev/test: route the warning through Wide Events so it surfaces in
    // structured logs instead of a raw console.warn that gets swallowed.
    const msg = `ENCRYPTION_KEY should be exactly 64 hex characters (current length: ${raw.length}). Padding with SHA-256 for dev use only.`;
    const event = getEvent();
    if (event) {
      event.addWarning(msg);
    } else if (typeof console !== "undefined") {
      console.warn("[crypto]", msg);
    }
    const padded = raw + createHash("sha256").update(raw, "utf8").digest("hex");
    return Buffer.from(padded.slice(0, 64), "hex");
  }

  throw new Error(
    "ENCRYPTION_KEY must be a hex string of at least 32 characters (64 recommended). " +
      "Generate one with: openssl rand -hex 32",
  );
}

/**
 * Encrypt a plaintext string.
 * Returns format: base64(iv + authTag + ciphertext)
 */
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  // Pack: iv (12) + authTag (16) + ciphertext
  const packed = Buffer.concat([iv, authTag, encrypted]);
  return packed.toString("base64");
}

/**
 * Decrypt a previously encrypted string.
 */
export function decrypt(encoded: string): string {
  const key = getKey();
  const packed = Buffer.from(encoded, "base64");

  const iv = packed.subarray(0, IV_LENGTH);
  const authTag = packed.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = packed.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}
