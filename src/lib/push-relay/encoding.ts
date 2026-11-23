/**
 * The byte encodings of the push relay wire (`spec/statements.md` of the
 * relay repository, "Common rules"): unpadded base64url for keys, signatures,
 * nonces and envelopes; lowercase hex inside signed texts; the token tag that
 * names a device token without carrying it.
 *
 * Every decoder here is strict. A padded value, a `+` or `/`, whitespace or a
 * wrong length is refused rather than repaired, because a value the relay
 * would refuse must be refused here first.
 */
import { createHash } from "node:crypto";

const B64URL_RE = /^[A-Za-z0-9_-]*$/;
const HEX_RE = /^(?:[0-9a-fA-F]{2})*$/;

/** Unpadded base64url of `bytes`. */
export function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/**
 * The bytes of an unpadded base64url string, or null when the text is not
 * canonical unpadded base64url or does not decode to `length` bytes.
 */
export function fromBase64Url(text: string, length?: number): Buffer | null {
  if (typeof text !== "string" || !B64URL_RE.test(text)) return null;
  // A length of 1 modulo 4 is never produced by an encoder.
  if (text.length % 4 === 1) return null;
  const bytes = Buffer.from(text, "base64url");
  // Reject non-canonical trailing bits: re-encoding must give the same text.
  if (bytes.toString("base64url") !== text) return null;
  if (length !== undefined && bytes.length !== length) return null;
  return bytes;
}

/** The bytes of a hex string, or null when it is not an even-length hex. */
export function fromHex(text: string): Buffer | null {
  if (typeof text !== "string" || !HEX_RE.test(text)) return null;
  return Buffer.from(text, "hex");
}

/** SHA-256 over the concatenation of `parts`. */
export function sha256(...parts: Uint8Array[]): Buffer {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest();
}

/** Lowercase hex SHA-256 of `body`; the body hash of the signed texts. */
export function bodyHashHex(body: Uint8Array | string): string {
  return sha256(
    typeof body === "string" ? Buffer.from(body, "utf8") : body,
  ).toString("hex");
}

const TOKEN_TAG_PREFIX = Buffer.from("hl-push-token", "ascii");
const KEY_ID_PREFIX = Buffer.from("hl-push-key", "ascii");

/** `SHA-256("hl-push-token" || token)[0..16]` over the raw token bytes. */
export function tokenTag(token: Uint8Array): Buffer {
  return sha256(TOKEN_TAG_PREFIX, token).subarray(0, 16);
}

/** The token tag of a hex device token as 32 lowercase hex characters. */
export function tokenTagHex(hexToken: string): string | null {
  const raw = fromHex(hexToken);
  if (!raw || raw.length === 0) return null;
  return tokenTag(raw).toString("hex");
}

/**
 * `SHA-256("hl-push-key" || pkR)[0..8]` as hex: the key id of a device key,
 * for APIs and display only. It never appears in an envelope.
 */
export function pushKeyId(publicKey: Uint8Array): string {
  return sha256(KEY_ID_PREFIX, publicKey).subarray(0, 8).toString("hex");
}
