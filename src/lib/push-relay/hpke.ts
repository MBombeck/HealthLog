/**
 * The push envelope, version 1, sealed on this server (`spec/envelope.md` of
 * the relay repository): HPKE (RFC 9180) in `mode_auth` with DHKEM(X25519,
 * HKDF-SHA256), HKDF-SHA256 and ChaCha20-Poly1305, on `node:crypto` alone.
 *
 * Auth mode, not base mode: in base mode anybody who knows a device public
 * key can build an envelope the device opens. In auth mode only the holder of
 * a sender key the device has pinned can.
 *
 * The ephemeral key is generated inside every seal and never accepted from a
 * caller. Reusing it for the same recipient reuses the AEAD key and nonce,
 * which with ChaCha20-Poly1305 reveals the XOR of two plaintexts and allows
 * forgeries. A retry therefore resends the finished envelope and never seals
 * again. The golden-vector test reproduces the vector bytes by replacing the
 * key generator of `node:crypto` in its own module scope; no function here
 * takes a key it did not make (`push-relay-ephemeral-guard.test.ts`).
 */
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";

import { tokenTag } from "@/lib/push-relay/encoding";

/**
 * The classes this server seals. Class byte `0x03` (Live Activity) is
 * reserved by the envelope format and never sealed: a Live Activity end
 * travels without an envelope.
 */
export type EnvelopeClass = "alert" | "silent";

export const ENVELOPE_VERSION = 0x01;
export const ENVELOPE_SUITE = 0x01;
export const CLASS_BYTE: Record<EnvelopeClass, number> = {
  alert: 0x01,
  silent: 0x02,
};
/** Padded plaintext size per class. */
export const BUCKET: Record<EnvelopeClass, number> = {
  alert: 1024,
  silent: 1024,
};
/** The longest `exp - iat` a receiver accepts per class, in seconds. */
export const MAX_LIFETIME_S: Record<EnvelopeClass, number> = {
  alert: 6 * 3600,
  silent: 3600,
};
export const INFO = Buffer.from("HealthLog push envelope v1", "ascii");
const HEADER_LEN = 3;
const ENC_LEN = 32;
const TAG_LEN = 16;

export function envelopeLength(pushClass: EnvelopeClass): number {
  return HEADER_LEN + ENC_LEN + BUCKET[pushClass] + TAG_LEN;
}

const i2osp = (n: number, len: number) => {
  const b = Buffer.alloc(len);
  b.writeUIntBE(n, 0, len);
  return b;
};
const V1 = Buffer.from("HPKE-v1", "ascii");
const KEM_SUITE = Buffer.concat([Buffer.from("KEM", "ascii"), i2osp(0x20, 2)]);
const HPKE_SUITE = Buffer.concat([
  Buffer.from("HPKE", "ascii"),
  i2osp(0x20, 2),
  i2osp(0x01, 2),
  i2osp(0x03, 2),
]);
const MODE_AUTH = 0x02;

function extract(salt: Buffer, ikm: Buffer): Buffer {
  return createHmac("sha256", salt.length ? salt : Buffer.alloc(32))
    .update(ikm)
    .digest();
}

function expand(prk: Buffer, info: Buffer, length: number): Buffer {
  let t = Buffer.alloc(0);
  let out = Buffer.alloc(0);
  for (let i = 1; out.length < length; i++) {
    t = createHmac("sha256", prk)
      .update(Buffer.concat([t, info, Buffer.from([i])]))
      .digest();
    out = Buffer.concat([out, t]);
  }
  return out.subarray(0, length);
}

const labeledExtract = (
  suite: Buffer,
  salt: Buffer,
  label: string,
  ikm: Buffer,
) => extract(salt, Buffer.concat([V1, suite, Buffer.from(label), ikm]));

const labeledExpand = (
  suite: Buffer,
  prk: Buffer,
  label: string,
  info: Buffer,
  length: number,
) =>
  expand(
    prk,
    Buffer.concat([i2osp(length, 2), V1, suite, Buffer.from(label), info]),
    length,
  );

const X25519_SPKI = Buffer.from("302a300506032b656e032100", "hex");
const X25519_PKCS8 = Buffer.from("302e020100300506032b656e04220420", "hex");

/** A KeyObject for a raw 32-byte X25519 public key. */
export function x25519PublicKey(raw: Uint8Array): KeyObject {
  return createPublicKey({
    key: Buffer.concat([X25519_SPKI, raw]),
    format: "der",
    type: "spki",
  });
}

/** A KeyObject for a raw 32-byte X25519 private key. */
export function x25519PrivateKey(raw: Uint8Array): KeyObject {
  return createPrivateKey({
    key: Buffer.concat([X25519_PKCS8, raw]),
    format: "der",
    type: "pkcs8",
  });
}

/** The raw 32-byte public key of an X25519 KeyObject (private or public). */
export function x25519RawPublic(key: KeyObject): Buffer {
  const pub = key.type === "private" ? createPublicKey(key) : key;
  return pub.export({ format: "der", type: "spki" }).subarray(12);
}

/** A fresh X25519 pair as raw bytes. */
export function generateX25519(): { privateKey: Buffer; publicKey: Buffer } {
  const { privateKey } = generateKeyPairSync("x25519");
  return {
    privateKey: privateKey
      .export({ format: "der", type: "pkcs8" })
      .subarray(X25519_PKCS8.length),
    publicKey: x25519RawPublic(privateKey),
  };
}

/**
 * Whether `pk` may be sealed to: 32 bytes, and an X25519 derivation against it
 * does not yield the all-zero secret (the low-order points of Curve25519).
 */
export function isValidRecipientKey(pk: Uint8Array | null): boolean {
  if (!pk || pk.length !== 32) return false;
  try {
    const probe = generateKeyPairSync("x25519").privateKey;
    const secret = diffieHellman({
      privateKey: probe,
      publicKey: x25519PublicKey(pk),
    });
    return !secret.every((b) => b === 0);
  } catch {
    return false;
  }
}

function extractAndExpand(dh: Buffer, kemContext: Buffer): Buffer {
  const prk = labeledExtract(KEM_SUITE, Buffer.alloc(0), "eae_prk", dh);
  return labeledExpand(KEM_SUITE, prk, "shared_secret", kemContext, 32);
}

/** The key schedule of `mode_auth` without a PSK. */
export function keySchedule(shared: Buffer): { key: Buffer; nonce: Buffer } {
  const empty = Buffer.alloc(0);
  const pskIdHash = labeledExtract(HPKE_SUITE, empty, "psk_id_hash", empty);
  const infoHash = labeledExtract(HPKE_SUITE, empty, "info_hash", INFO);
  const context = Buffer.concat([
    Buffer.from([MODE_AUTH]),
    pskIdHash,
    infoHash,
  ]);
  const secret = labeledExtract(HPKE_SUITE, shared, "secret", empty);
  return {
    key: labeledExpand(HPKE_SUITE, secret, "key", context, 32),
    nonce: labeledExpand(HPKE_SUITE, secret, "base_nonce", context, 12),
  };
}

/** `AuthDecap`: the shared secret a recipient derives from `enc` and `pkS`. */
export function authDecap(
  enc: Uint8Array,
  skR: Uint8Array,
  pkS: Uint8Array,
): Buffer {
  const recipient = x25519PrivateKey(skR);
  const dh = Buffer.concat([
    diffieHellman({ privateKey: recipient, publicKey: x25519PublicKey(enc) }),
    diffieHellman({ privateKey: recipient, publicKey: x25519PublicKey(pkS) }),
  ]);
  return extractAndExpand(
    dh,
    Buffer.concat([enc, x25519RawPublic(recipient), pkS]),
  );
}

/** The AAD of an envelope: its 3-byte header and the device token tag. */
export function envelopeAad(header: Buffer, apnsToken: Uint8Array): Buffer {
  return Buffer.concat([header, tokenTag(apnsToken)]);
}

/** ChaCha20-Poly1305 open; throws on a failed tag. */
export function aeadOpen(
  key: Buffer,
  nonce: Buffer,
  aad: Buffer,
  sealed: Buffer,
): Buffer {
  const decipher = createDecipheriv("chacha20-poly1305", key, nonce, {
    authTagLength: TAG_LEN,
  });
  decipher.setAAD(aad, { plaintextLength: sealed.length - TAG_LEN });
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG_LEN));
  return Buffer.concat([
    decipher.update(sealed.subarray(0, sealed.length - TAG_LEN)),
    decipher.final(),
  ]);
}

export class EnvelopeSealError extends Error {
  constructor(readonly code: "invalidRecipientKey" | "payloadTooLarge") {
    super(code);
    this.name = "EnvelopeSealError";
  }
}

/**
 * Seal one padded plaintext for one device. `padded` must be exactly the
 * bucket of the class. The ephemeral key is made here, once, and discarded.
 */
export function sealPadded(input: {
  pushClass: EnvelopeClass;
  padded: Buffer;
  recipientPublicKey: Uint8Array;
  senderPrivateKey: Uint8Array;
  apnsToken: Uint8Array;
}): Buffer {
  if (!isValidRecipientKey(input.recipientPublicKey)) {
    throw new EnvelopeSealError("invalidRecipientKey");
  }
  if (input.padded.length !== BUCKET[input.pushClass]) {
    throw new EnvelopeSealError("payloadTooLarge");
  }
  const header = Buffer.from([
    ENVELOPE_VERSION,
    ENVELOPE_SUITE,
    CLASS_BYTE[input.pushClass],
  ]);
  const ephemeral = generateKeyPairSync("x25519").privateKey;
  const sender = x25519PrivateKey(input.senderPrivateKey);
  const recipient = x25519PublicKey(input.recipientPublicKey);
  const enc = x25519RawPublic(ephemeral);
  const dh = Buffer.concat([
    diffieHellman({ privateKey: ephemeral, publicKey: recipient }),
    diffieHellman({ privateKey: sender, publicKey: recipient }),
  ]);
  const shared = extractAndExpand(
    dh,
    Buffer.concat([enc, input.recipientPublicKey, x25519RawPublic(sender)]),
  );
  const { key, nonce } = keySchedule(shared);
  const aad = envelopeAad(header, input.apnsToken);
  const cipher = createCipheriv("chacha20-poly1305", key, nonce, {
    authTagLength: TAG_LEN,
  });
  cipher.setAAD(aad, { plaintextLength: input.padded.length });
  const sealed = Buffer.concat([
    cipher.update(input.padded),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return Buffer.concat([header, enc, sealed]);
}
