/**
 * AES-256-GCM encryption for sensitive data at rest.
 *
 * v1.4: supports key versioning + rotation. Multiple keys can coexist via
 * `ENCRYPTION_KEYS` (JSON map of `{ "<id>": "<base64-or-hex-key>" }`) plus
 * `ENCRYPTION_ACTIVE_KEY_ID` selecting which one to write with. Backwards
 * compatible: if `ENCRYPTION_KEYS` is absent, the legacy single
 * `ENCRYPTION_KEY` is used with synthetic id `"v1"`.
 *
 * Ciphertext format:
 *   - Versioned (new):   "<keyId>.<base64(iv|authTag|ciphertext)>"
 *   - Legacy (v1):       "base64(iv|authTag|ciphertext)" — still readable.
 *
 * The decryption path tries the versioned format first; if no `.` is present
 * (or the prefix is not a known key id), it falls back to the legacy single
 * key so that rows written before the rotation continue to decrypt.
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
const LEGACY_KEY_ID = "v1";

interface KeyMaterial {
  id: string;
  key: Buffer;
}

let cachedKeys: Map<string, Buffer> | null = null;
let cachedActiveId: string | null = null;
let cachedSignature: string | null = null;

function envSignature(): string {
  return [
    process.env.ENCRYPTION_KEYS ?? "",
    process.env.ENCRYPTION_ACTIVE_KEY_ID ?? "",
    process.env.ENCRYPTION_KEY ?? "",
  ].join("|");
}

function decodeKey(raw: string, label: string): Buffer {
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, "hex");
  }
  // base64 form (32 bytes / 256 bits)
  if (/^[A-Za-z0-9+/=]+$/.test(raw)) {
    try {
      const buf = Buffer.from(raw, "base64");
      if (buf.length === 32) return buf;
    } catch {
      // fall through
    }
  }
  if (/^[0-9a-fA-F]+$/.test(raw) && raw.length >= 32) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        `Encryption key '${label}' must be 64 hex characters (256 bits) in production. ` +
          `Generate one with: openssl rand -hex 32`,
      );
    }
    const msg = `Encryption key '${label}' should be exactly 64 hex characters (current length: ${raw.length}). Padding with SHA-256 for dev use only.`;
    const event = getEvent();
    if (event) event.addWarning(msg);
    else if (typeof console !== "undefined") console.warn("[crypto]", msg);
    const padded = raw + createHash("sha256").update(raw, "utf8").digest("hex");
    return Buffer.from(padded.slice(0, 64), "hex");
  }
  throw new Error(
    `Encryption key '${label}' must be hex (>= 32 chars) or base64 (32 bytes). ` +
      `Generate one with: openssl rand -hex 32`,
  );
}

function loadKeys(): { keys: Map<string, Buffer>; activeId: string } {
  const sig = envSignature();
  if (cachedKeys && cachedActiveId && cachedSignature === sig) {
    return { keys: cachedKeys, activeId: cachedActiveId };
  }

  const keys = new Map<string, Buffer>();
  let activeId: string | null = null;

  const rawMap = process.env.ENCRYPTION_KEYS;
  if (rawMap && rawMap.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawMap);
    } catch (err) {
      throw new Error(
        `ENCRYPTION_KEYS must be valid JSON (e.g. {"v2":"<hex>"}): ${(err as Error).message}`,
      );
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("ENCRYPTION_KEYS must be a JSON object map");
    }
    for (const [id, value] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      if (typeof value !== "string" || !id) {
        throw new Error(`ENCRYPTION_KEYS entry '${id}' is not a string`);
      }
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) {
        throw new Error(
          `ENCRYPTION_KEYS id '${id}' must match [A-Za-z0-9_-]{1,32}`,
        );
      }
      keys.set(id, decodeKey(value, id));
    }

    activeId = process.env.ENCRYPTION_ACTIVE_KEY_ID ?? null;
    if (!activeId) {
      if (keys.size === 1) {
        activeId = keys.keys().next().value as string;
      } else {
        throw new Error(
          "ENCRYPTION_ACTIVE_KEY_ID must be set when ENCRYPTION_KEYS has multiple entries",
        );
      }
    }
    if (!keys.has(activeId)) {
      throw new Error(
        `ENCRYPTION_ACTIVE_KEY_ID='${activeId}' has no matching entry in ENCRYPTION_KEYS`,
      );
    }
  }

  // Always also include the legacy single-key under id `v1` if set, so old
  // rows decrypt. If the operator supplies the same id explicitly, that wins.
  const legacyRaw = process.env.ENCRYPTION_KEY;
  if (legacyRaw && legacyRaw.trim() !== "") {
    if (!keys.has(LEGACY_KEY_ID)) {
      keys.set(LEGACY_KEY_ID, decodeKey(legacyRaw, LEGACY_KEY_ID));
    }
    if (!activeId) activeId = LEGACY_KEY_ID;
  }

  if (keys.size === 0 || !activeId) {
    throw new Error(
      "Encryption is not configured. Set ENCRYPTION_KEY or ENCRYPTION_KEYS+ENCRYPTION_ACTIVE_KEY_ID.",
    );
  }

  cachedKeys = keys;
  cachedActiveId = activeId;
  cachedSignature = sig;
  return { keys, activeId };
}

function getActiveKey(): KeyMaterial {
  const { keys, activeId } = loadKeys();
  return { id: activeId, key: keys.get(activeId)! };
}

function getKeyById(id: string): Buffer | null {
  const { keys } = loadKeys();
  return keys.get(id) ?? null;
}

/** Test helper — drops the cached key map so env stubs take effect. */
export function _resetCryptoCacheForTests(): void {
  cachedKeys = null;
  cachedActiveId = null;
  cachedSignature = null;
}

export function getActiveKeyId(): string {
  return getActiveKey().id;
}

function encryptWithKey(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

function decryptWithKey(payload: string, key: Buffer): string {
  const packed = Buffer.from(payload, "base64");
  const iv = packed.subarray(0, IV_LENGTH);
  const tag = packed.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ct = packed.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const dec = createDecipheriv(ALGORITHM, key, iv);
  dec.setAuthTag(tag);
  return Buffer.concat([dec.update(ct), dec.final()]).toString("utf8");
}

/**
 * Encrypt a plaintext string with the active key.
 * Returns format: `<keyId>.<base64(iv+authTag+ciphertext)>`
 */
export function encrypt(plaintext: string): string {
  const { id, key } = getActiveKey();
  return `${id}.${encryptWithKey(plaintext, key)}`;
}

/**
 * Decrypt a previously encrypted string. Accepts both the versioned
 * `<id>.<payload>` format and the legacy bare-base64 format.
 *
 * Once the prefix is recognised as a versioned id we trust the key id.
 * If decrypt fails under that key the error surfaces — silently retrying as
 * legacy would mask data corruption.
 */
export function decrypt(encoded: string): string {
  const dot = encoded.indexOf(".");
  if (dot > 0 && dot < encoded.length - 1) {
    const id = encoded.slice(0, dot);
    const payload = encoded.slice(dot + 1);
    if (/^[A-Za-z0-9_-]{1,32}$/.test(id)) {
      const key = getKeyById(id);
      if (!key) {
        throw new Error(
          `Encryption key id '${id}' is not configured. Add it to ` +
            `ENCRYPTION_KEYS before decrypting rows written under that key.`,
        );
      }
      return decryptWithKey(payload, key);
    }
  }
  // Legacy bare-base64 row. Refuse to decrypt under the active key — that
  // would give an opaque GCM tag error AND succeed silently with junk if a
  // key collision ever occurs. Require the operator to keep the v1 key in
  // `ENCRYPTION_KEYS` until rotation has fully drained legacy rows.
  const legacy = getKeyById(LEGACY_KEY_ID);
  if (!legacy) {
    throw new Error(
      "Found a legacy-format ciphertext but no v1 key is configured. " +
        "Restore the original ENCRYPTION_KEY (or add a 'v1' entry to " +
        "ENCRYPTION_KEYS) and run scripts/rotate-encryption-key.ts before " +
        "removing it.",
    );
  }
  return decryptWithKey(encoded, legacy);
}

/** Re-encrypt a row with the currently active key. Used by the rotation CLI. */
export function reencryptToActive(encoded: string): string {
  return encrypt(decrypt(encoded));
}

/** Returns the key id portion of a versioned ciphertext, or null for legacy. */
export function extractKeyId(encoded: string): string | null {
  const dot = encoded.indexOf(".");
  if (dot <= 0 || dot >= encoded.length - 1) return null;
  const id = encoded.slice(0, dot);
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) return null;
  return id;
}
