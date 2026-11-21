/**
 * The signed texts of the relay protocol that this server builds or checks
 * (`spec/statements.md` of the relay repository), and the Ed25519 helpers
 * they need.
 *
 * Every statement is ASCII, its fields joined by a single line feed with none
 * before the first or after the last; binary values are lowercase hex, except
 * the request nonce, which appears exactly as it travels. The first field
 * names the statement and its version, so a signature for one statement never
 * verifies as another, and the relay host is signed, so a statement for one
 * relay never verifies at another.
 */
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";

import { bodyHashHex, fromBase64Url } from "@/lib/push-relay/encoding";

const ED25519_PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");
const ED25519_SPKI = Buffer.from("302a300506032b6570032100", "hex");

/** A fresh Ed25519 pair; the private half is the 32-byte seed. */
export function generateEd25519(): { seed: Buffer; publicKey: Buffer } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    seed: privateKey
      .export({ format: "der", type: "pkcs8" })
      .subarray(ED25519_PKCS8.length),
    publicKey: publicKey.export({ format: "der", type: "spki" }).subarray(12),
  };
}

/** The raw public key of an Ed25519 seed. */
export function ed25519PublicOf(seed: Uint8Array): Buffer {
  const key = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8, seed]),
    format: "der",
    type: "pkcs8",
  });
  return createPublicKey(key)
    .export({ format: "der", type: "spki" })
    .subarray(12);
}

/** Pure Ed25519 over the UTF-8 bytes of `text`. */
export function signText(seed: Uint8Array, text: string): Buffer {
  const key = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8, seed]),
    format: "der",
    type: "pkcs8",
  });
  return sign(null, Buffer.from(text, "utf8"), key);
}

/** Whether `signature` is a valid Ed25519 signature of `text` by `publicKey`. */
export function verifyText(
  publicKey: Uint8Array,
  text: string,
  signature: Uint8Array,
): boolean {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  try {
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI, publicKey]),
      format: "der",
      type: "spki",
    });
    return verify(null, Buffer.from(text, "utf8"), key, signature);
  } catch {
    return false;
  }
}

/** Verify a base64url signature against base64url keys; false when malformed. */
export function verifyEncoded(
  publicKeyB64: string,
  text: string,
  signatureB64: string,
): boolean {
  const publicKey = fromBase64Url(publicKeyB64, 32);
  const signature = fromBase64Url(signatureB64, 64);
  if (!publicKey || !signature) return false;
  return verifyText(publicKey, text, signature);
}

const join = (...fields: Array<string | number>) => fields.join("\n");

/** `hl-register-v1`: proof of possession of a new instance key. */
export function registerText(
  host: string,
  publicKey: Uint8Array,
  time: number,
): string {
  return join(
    "hl-register-v1",
    host,
    Buffer.from(publicKey).toString("hex"),
    time,
  );
}

/** `hl-relay-v1`: the instance's signature over one request. */
export function requestText(input: {
  host: string;
  instanceId: string;
  method: string;
  pathAndQuery: string;
  timestamp: number;
  nonce: string;
  body: Uint8Array | string;
}): string {
  return join(
    "hl-relay-v1",
    input.host,
    input.instanceId,
    input.method.toUpperCase(),
    input.pathAndQuery,
    input.timestamp,
    input.nonce,
    bodyHashHex(input.body),
  );
}

/**
 * `hl-relay-resp-v2`: the relay's signature over one response, bound to the
 * request's method, raw path with query and nonce.
 */
export function responseText(input: {
  host: string;
  method: string;
  pathAndQuery: string;
  nonce: string | null;
  status: number;
  body: Uint8Array | string;
}): string {
  return join(
    "hl-relay-resp-v2",
    input.host,
    input.method.toUpperCase(),
    input.pathAndQuery,
    input.nonce ?? "-",
    input.status,
    bodyHashHex(input.body),
  );
}

/** `hl-bind-v1`: the device statement that binds a token to one instance. */
export function bindText(input: {
  host: string;
  instanceId: string;
  tokenTag: string;
  kind: string;
  seq: number;
  iat: number;
}): string {
  return join(
    "hl-bind-v1",
    input.host,
    input.instanceId,
    input.tokenTag,
    input.kind,
    input.seq,
    input.iat,
  );
}

/** `hl-activity-v1`: the device statement that allows one Live Activity end. */
export function activityText(input: {
  host: string;
  instanceId: string;
  tokenTag: string;
  laTokenTag: string;
  iat: number;
}): string {
  return join(
    "hl-activity-v1",
    input.host,
    input.instanceId,
    input.tokenTag,
    input.laTokenTag,
    input.iat,
  );
}
