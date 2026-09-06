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
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { Buffer } from "node:buffer";
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
    // Fail closed unless we are explicitly in a local dev or test run. The
    // SHA-256 padding below derives a key the operator never recorded; if a
    // staging/preview container runs with NODE_ENV unset it would silently
    // encrypt under that derived key, and rotating to a real key later
    // orphans those rows (decrypt is fail-closed → undecryptable). Only the
    // two known throwaway-data environments may take the padding path; every
    // other case (production AND unset NODE_ENV) throws the same hard error.
    const env = process.env.NODE_ENV;
    if (env !== "development" && env !== "test") {
      throw new Error(
        `Encryption key '${label}' must be 64 hex characters (256 bits) outside development/test. ` +
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

/**
 * The configured key ids (NOT the key material). Used by the admin
 * encryption-status view to report how many keys the operator has loaded and
 * by the rotation guard. Never expose the bytes — only the ids.
 */
export function getConfiguredKeyIds(): string[] {
  const { keys } = loadKeys();
  return [...keys.keys()];
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

// ─── Binary codec ("binary2") ────────────────────────────────────────────────
//
// AES-256-GCM over raw bytes, skipping the base64 detour the string codec
// takes (−33 % at rest, one fewer full copy in memory). Written for large
// binary payloads (the document vault's `contentEncrypted`); the consumer
// records which codec a row uses in an explicit column — the layout is never
// header-sniffed against the string codec.
//
// Layout: [version 0x02][keyIdLen u8][keyId ascii][iv 12][tag 16][ciphertext]
//
// Same versioned-key discipline as the string codec: encrypt always writes
// the active key id, decrypt is fail-closed on an unknown version, a
// malformed header, or an unconfigured key id.

/** Version byte identifying the binary2 layout. */
const BYTES_CODEC_VERSION = 0x02;

/** Encrypt raw bytes with the active key into the binary2 layout. */
export function encryptBytes(plaintext: Buffer): Buffer {
  const { id, key } = getActiveKey();
  const keyId = Buffer.from(id, "ascii");
  if (keyId.byteLength < 1 || keyId.byteLength > 32) {
    // loadKeys() already constrains ids to [A-Za-z0-9_-]{1,32}; belt-and-braces.
    throw new Error(`Encryption key id '${id}' is not header-encodable`);
  }
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const header = Buffer.from([BYTES_CODEC_VERSION, keyId.byteLength]);
  return Buffer.concat([header, keyId, iv, tag, ct]);
}

/** Parse a binary2 header. Throws on any malformation (fail-closed). */
function parseBytesHeader(payload: Buffer): {
  keyId: string;
  iv: Buffer;
  tag: Buffer;
  ct: Buffer;
} {
  if (payload.byteLength < 2) {
    throw new Error("binary2 payload is truncated (no header)");
  }
  if (payload[0] !== BYTES_CODEC_VERSION) {
    throw new Error(
      `Unknown binary ciphertext version ${payload[0]} (expected ${BYTES_CODEC_VERSION})`,
    );
  }
  const keyIdLen = payload[1];
  if (keyIdLen < 1 || keyIdLen > 32) {
    throw new Error("binary2 payload has an invalid key-id length");
  }
  const fixed = 2 + keyIdLen + IV_LENGTH + AUTH_TAG_LENGTH;
  if (payload.byteLength < fixed) {
    throw new Error("binary2 payload is truncated");
  }
  const keyId = payload.subarray(2, 2 + keyIdLen).toString("ascii");
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(keyId)) {
    throw new Error("binary2 payload carries a malformed key id");
  }
  const iv = payload.subarray(2 + keyIdLen, 2 + keyIdLen + IV_LENGTH);
  const tag = payload.subarray(2 + keyIdLen + IV_LENGTH, fixed);
  const ct = payload.subarray(fixed);
  return { keyId, iv, tag, ct };
}

/**
 * Decrypt a binary2 payload back to its raw bytes. Fail-closed: an unknown
 * version, a malformed header, or an unconfigured key id throws — the caller
 * must treat a throw as "cannot serve", never fall back to the ciphertext.
 */
export function decryptBytes(payload: Buffer): Buffer {
  const { keyId, iv, tag, ct } = parseBytesHeader(payload);
  const key = getKeyById(keyId);
  if (!key) {
    throw new Error(
      `Encryption key id '${keyId}' is not configured. Add it to ` +
        `ENCRYPTION_KEYS before decrypting rows written under that key.`,
    );
  }
  const dec = createDecipheriv(ALGORITHM, key, iv);
  dec.setAuthTag(tag);
  return Buffer.concat([dec.update(ct), dec.final()]);
}

/** The key id a binary2 payload was written under, or null when unparsable. */
export function extractKeyIdFromBytes(payload: Buffer): string | null {
  try {
    return parseBytesHeader(payload).keyId;
  } catch {
    return null;
  }
}

/** Re-encrypt a binary2 payload with the active key. Used by rotation. */
export function reencryptBytesToActive(payload: Buffer): Buffer {
  return encryptBytes(decryptBytes(payload));
}

// ─── HKDF subkey derivation ──────────────────────────────────────────────────
//
// A purpose-bound key derived from the master key material via HKDF-SHA256.
// Used where a deterministic secondary key is needed that must NEVER be the raw
// master key, the HMAC auth key, or a stored column — the document vault's blind
// content-search index derives its HMAC token subkey this way (P2-D7). The
// derivation follows the ACTIVE key: rotating the master key changes the subkey,
// which is why the index rotation re-tokenises from the stored ciphertext.

/**
 * Derive a 32-byte purpose-bound subkey from the ACTIVE encryption key using
 * HKDF-SHA256 with `info` as the domain-separation label. Deterministic for a
 * given (active key, info) pair; opaque without the master key. The returned
 * bytes are secret — never persist or log them.
 */
export function deriveSubkey(info: string): Buffer {
  const { key } = getActiveKey();
  // Empty salt: HKDF-Extract uses a zero salt (RFC 5869 §2.2). Domain
  // separation lives entirely in `info`, so two purposes never collide.
  const derived = hkdfSync("sha256", key, new Uint8Array(0), info, 32);
  return Buffer.from(derived);
}

/** Returns the key id portion of a versioned ciphertext, or null for legacy. */
export function extractKeyId(encoded: string): string | null {
  const dot = encoded.indexOf(".");
  if (dot <= 0 || dot >= encoded.length - 1) return null;
  const id = encoded.slice(0, dot);
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) return null;
  return id;
}

// ─── Streaming codec ("stream1") ─────────────────────────────────────────────
//
// AES-256-GCM over a plaintext that is produced INCREMENTALLY and consumed as
// one base64 string. Written for the weekly backup blob, whose plaintext is
// hundreds of megabytes on a long-lived record: the string codec above has to
// hold the whole plaintext, the whole ciphertext AND the whole base64 at once,
// which is three full copies of a record that already does not fit.
//
// Layout: "~hlgcm1." + keyId + "." + base64(iv | ciphertext | authTag)
//
// Two deliberate differences from the string codec, and no others:
//
//   - The tag rides at the END rather than in front of the ciphertext. GCM
//     only produces it once the last block is in, so a leading tag is what
//     makes the string codec un-streamable. Nothing about the authentication
//     changes: the tag still covers every ciphertext byte and `decryptStream`
//     still verifies it BEFORE returning a single plaintext byte.
//   - The `~` prefix. Key ids match [A-Za-z0-9_-]{1,32} and a legacy payload is
//     bare base64, so no value the string codec can ever write starts with a
//     tilde. The two formats are disjoint by construction rather than by
//     sniffing, which is why `decrypt()` below is left untouched.
//
// The write side never materialises the ciphertext: base64 is emitted in
// 3-byte-aligned pieces as the cipher produces them, with the sub-group
// remainder carried across chunks. The read side is deliberately NOT
// incremental — a caller that reads a backup parses it as one document
// anyway, and releasing unverified plaintext to save a copy would trade the
// authentication for memory.

/** Marker prefix of a streamed ciphertext. Disjoint from every other format. */
const STREAM_CODEC_PREFIX = "~hlgcm1.";

/**
 * Incremental AES-256-GCM writer over raw bytes.
 *
 * The byte-level half of the codec, split out from the base64 one below
 * because not every destination is a text column. `iv | update()* | final()`
 * concatenated in order is the same `iv | ciphertext | authTag` the base64
 * form encodes, so the two write the same bytes and only differ in how they
 * are framed on the way out.
 *
 * The key is passed in rather than looked up. Every application row goes
 * through `createStreamEncryptor()` under the active `ENCRYPTION_KEYS` entry,
 * but the off-host backup is deliberately encrypted under a SEPARATE key
 * (`BACKUP_ENCRYPTION_KEY`) so a leak of one does not expose the other — and
 * it needs this exact writer, not a second scheme.
 */
export interface RawStreamEncryptor {
  /** The 12-byte IV. Belongs in front of the ciphertext. */
  readonly iv: Buffer;
  /** Encrypt one plaintext chunk. May return an empty buffer. */
  update(chunk: Buffer): Buffer;
  /** Flush the cipher and append the auth tag. No further calls after this. */
  final(): Buffer;
}

/** Open a byte-level streaming encryptor under an explicit 32-byte key. */
export function createRawStreamEncryptor(key: Buffer): RawStreamEncryptor {
  if (key.byteLength !== 32) {
    throw new Error("Stream encryption key must be 32 bytes");
  }
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  let done = false;

  return {
    iv,
    update(chunk: Buffer): Buffer {
      if (done) throw new Error("Stream encryptor already finalised");
      return cipher.update(chunk);
    },
    final(): Buffer {
      if (done) throw new Error("Stream encryptor already finalised");
      done = true;
      // The tag is plaintext-independent trailing data, so it simply joins
      // the byte stream.
      return Buffer.concat([cipher.final(), cipher.getAuthTag()]);
    },
  };
}

/**
 * Verify and decrypt `iv | ciphertext | authTag` under an explicit key.
 *
 * Deliberately not incremental: the tag covers every ciphertext byte and is
 * checked by `final()` before a single plaintext byte is returned, and a
 * caller that reads a backup parses it as one document anyway. Releasing
 * unverified plaintext to save a copy would trade the authentication for
 * memory.
 */
export function decryptRawStream(packed: Buffer, key: Buffer): Buffer {
  if (packed.byteLength < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error("Streamed ciphertext is truncated");
  }
  const iv = packed.subarray(0, IV_LENGTH);
  const tag = packed.subarray(packed.byteLength - AUTH_TAG_LENGTH);
  const ct = packed.subarray(IV_LENGTH, packed.byteLength - AUTH_TAG_LENGTH);
  const dec = createDecipheriv(ALGORITHM, key, iv);
  dec.setAuthTag(tag);
  return Buffer.concat([dec.update(ct), dec.final()]);
}

/** Incremental AES-256-GCM writer. Emits base64 pieces; concatenate in order. */
export interface StreamEncryptor {
  /** The header, including base64(iv). Emit before any `update()` output. */
  readonly header: string;
  /** Encrypt one plaintext chunk into a base64 piece (may be empty). */
  update(chunk: Buffer): string;
  /** Flush the cipher and the auth tag. No further calls after this. */
  final(): string;
}

/**
 * Open a streaming encryptor under the ACTIVE key, framed as base64.
 *
 * The 12-byte IV is exactly four base64 groups, so it encodes standalone and
 * the ciphertext continues on a group boundary — which is what lets the rest
 * be emitted piecewise without ever holding the whole thing.
 */
export function createStreamEncryptor(): StreamEncryptor {
  const { id, key } = getActiveKey();
  const raw = createRawStreamEncryptor(key);
  // Bytes that did not fill a 3-byte base64 group in the previous chunk.
  let carry = Buffer.alloc(0);

  const emit = (bytes: Buffer): string => {
    const buf = carry.byteLength > 0 ? Buffer.concat([carry, bytes]) : bytes;
    const aligned = buf.byteLength - (buf.byteLength % 3);
    carry = Buffer.from(buf.subarray(aligned));
    return aligned === 0 ? "" : buf.subarray(0, aligned).toString("base64");
  };

  return {
    header: `${STREAM_CODEC_PREFIX}${id}.${raw.iv.toString("base64")}`,
    update(chunk: Buffer): string {
      return emit(raw.update(chunk));
    },
    final(): string {
      // The last group is padded exactly once, here.
      const tail = Buffer.concat([carry, raw.final()]);
      carry = Buffer.alloc(0);
      return tail.toString("base64");
    },
  };
}

/** True when `stored` was written by `createStreamEncryptor`. */
export function isStreamCiphertext(stored: string): boolean {
  return stored.startsWith(STREAM_CODEC_PREFIX);
}

/**
 * Decrypt a streamed ciphertext back to its raw plaintext bytes.
 *
 * Fail-closed on every arm — a malformed header, an unconfigured key id, a
 * truncated payload or a tag that does not verify all throw, and no plaintext
 * is returned until `final()` has authenticated the whole ciphertext.
 */
export function decryptStream(stored: string): Buffer {
  if (!isStreamCiphertext(stored)) {
    throw new Error("Not a streamed ciphertext");
  }
  const rest = stored.slice(STREAM_CODEC_PREFIX.length);
  const dot = rest.indexOf(".");
  if (dot <= 0 || dot >= rest.length - 1) {
    throw new Error("Streamed ciphertext has a malformed header");
  }
  const keyId = rest.slice(0, dot);
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(keyId)) {
    throw new Error("Streamed ciphertext carries a malformed key id");
  }
  const key = getKeyById(keyId);
  if (!key) {
    throw new Error(
      `Encryption key id '${keyId}' is not configured. Add it to ` +
        `ENCRYPTION_KEYS before decrypting rows written under that key.`,
    );
  }
  return decryptRawStream(Buffer.from(rest.slice(dot + 1), "base64"), key);
}

/** The key id a streamed ciphertext was written under, or null when unparsable. */
export function extractStreamKeyId(stored: string): string | null {
  if (!isStreamCiphertext(stored)) return null;
  const rest = stored.slice(STREAM_CODEC_PREFIX.length);
  const dot = rest.indexOf(".");
  if (dot <= 0) return null;
  const keyId = rest.slice(0, dot);
  return /^[A-Za-z0-9_-]{1,32}$/.test(keyId) ? keyId : null;
}
