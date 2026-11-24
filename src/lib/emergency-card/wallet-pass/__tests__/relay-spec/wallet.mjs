// Reference implementation of the wallet signing protocol (spec/wallet.md), with node:crypto only:
// the manifest check, the detached CMS SignedData, and, for the test vectors, a deterministic derivation of
// RSA keys from a seed and a minimal X.509 writer. A HealthLog server that signs locally can copy this file
// and must produce the same bytes as the relay (vector walletSign).
// SPDX-License-Identifier: CC0-1.0
import crypto from "node:crypto";

// ---- DER ----------------------------------------------------------------------------------------------

export function tlv(tag, ...parts) {
  const content = Buffer.concat(parts.map((p) => Buffer.from(p)));
  const n = content.length;
  let len;
  if (n < 0x80) len = [n];
  else if (n <= 0xff) len = [0x81, n];
  else if (n <= 0xffff) len = [0x82, n >> 8, n & 0xff];
  else len = [0x83, n >> 16, (n >> 8) & 0xff, n & 0xff];
  return Buffer.concat([Buffer.from([tag, ...len]), content]);
}

export function oid(dotted) {
  const arcs = dotted.split(".").map(BigInt);
  const out = [Number(arcs[0] * 40n + arcs[1])];
  for (const a of arcs.slice(2)) {
    const bytes = [];
    let v = a;
    do { bytes.unshift(Number(v & 0x7fn)); v >>= 7n; } while (v > 0n);
    for (let i = 0; i < bytes.length - 1; i++) bytes[i] |= 0x80;
    out.push(...bytes);
  }
  return tlv(0x06, Buffer.from(out));
}

export function bigToBytes(n) {
  let h = n.toString(16);
  if (h.length % 2) h = "0" + h;
  return Buffer.from(h, "hex");
}

export function integer(n) {
  let b = bigToBytes(BigInt(n));
  if (b.length === 0) b = Buffer.from([0]);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
}

const NULL = Buffer.from([0x05, 0x00]);
export const algorithm = (o) => tlv(0x30, oid(o), NULL);
export const utcTime = (date) => tlv(0x17, Buffer.from(date.toISOString().replace(/[-:T]/g, "").slice(2, 14) + "Z"));
export const setOf = (tag, ...elems) => tlv(tag, ...[...elems].sort(Buffer.compare));

export const OID = {
  data: "1.2.840.113549.1.7.1", signedData: "1.2.840.113549.1.7.2", sha256: "2.16.840.1.101.3.4.2.1",
  rsaEncryption: "1.2.840.113549.1.1.1", sha256WithRSA: "1.2.840.113549.1.1.11",
  contentType: "1.2.840.113549.1.9.3", messageDigest: "1.2.840.113549.1.9.4", signingTime: "1.2.840.113549.1.9.5",
};

// ---- Detached SignedData ------------------------------------------------------------------------------

export function signedAttributes(manifest, signingTime) {
  const digest = crypto.createHash("sha256").update(manifest).digest();
  const attr = (o, value) => tlv(0x30, oid(o), tlv(0x31, value));
  return setOf(0x31,
    attr(OID.contentType, oid(OID.data)),
    attr(OID.signingTime, utcTime(signingTime)),
    attr(OID.messageDigest, tlv(0x04, digest)));
}

// readTLV returns [tag, start of content, end] of the element at offset i of der.
function readTLV(der, i) {
  const tag = der[i];
  let len = der[i + 1], off = i + 2;
  if (len & 0x80) {
    const k = len & 0x7f;
    len = 0;
    for (let j = 0; j < k; j++) len = len * 256 + der[off + j];
    off += k;
  }
  return [tag, off, off + len];
}

// certParts returns the raw issuer Name and the serial INTEGER of a DER certificate.
export function certParts(der) {
  const [, certStart] = readTLV(der, 0);
  const [, tbsStart] = readTLV(der, certStart);
  let i = tbsStart;
  const [t0, , e0] = readTLV(der, i);
  if (t0 === 0xa0) i = e0; // version
  const [, , serialEnd] = readTLV(der, i);
  const serial = der.subarray(i, serialEnd);
  const [, , algEnd] = readTLV(der, serialEnd);
  const [, , issuerEnd] = readTLV(der, algEnd);
  return { issuer: der.subarray(algEnd, issuerEnd), serial };
}

export function signManifest(manifest, privateKey, certDer, intermediateDer, signingTime) {
  const attrs = signedAttributes(manifest, signingTime);
  const sig = crypto.sign("sha256", attrs, { key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING });
  const { issuer, serial } = certParts(certDer);
  const implicitAttrs = Buffer.concat([Buffer.from([0xa0]), attrs.subarray(1)]);
  const signerInfo = tlv(0x30, integer(1), tlv(0x30, issuer, serial), algorithm(OID.sha256), implicitAttrs,
    algorithm(OID.rsaEncryption), tlv(0x04, sig));
  const signed = tlv(0x30, integer(1), tlv(0x31, algorithm(OID.sha256)), tlv(0x30, oid(OID.data)),
    tlv(0xa0, certDer, intermediateDer), tlv(0x31, signerInfo));
  return { attrs, signature: tlv(0x30, oid(OID.signedData), tlv(0xa0, signed)) };
}

// ---- Manifest -----------------------------------------------------------------------------------------

export const PINNED = ["icon.png", "icon@2x.png", "icon@3x.png", "logo@2x.png", "logo@3x.png",
  "primaryLogo@2x.png", "primaryLogo@3x.png", "artwork@2x.png", "artwork@3x.png"];
export const LOCALES = ["de", "en", "es", "fr", "it", "ko", "nl", "pl", "pt-BR", "pt_BR", "ru"];
export const MAX_ENTRIES = 40;
export const MAX_BYTES = 8192;

// readObject reads one JSON object of string to string in order, as the relay does: duplicate keys,
// non-string values and trailing data are refused (null), where JSON.parse would keep the last key.
function readObject(text) {
  const STR = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;
  const WS = /[ \t\n\r]*/y;
  let i = 0;
  const ws = () => { WS.lastIndex = i; WS.exec(text); i = WS.lastIndex; };
  const str = () => { STR.lastIndex = i; const m = STR.exec(text); if (!m) return null; i = STR.lastIndex; return JSON.parse(m[0]); };
  const out = [];
  ws();
  if (text[i++] !== "{") return null;
  ws();
  if (text[i] === "}") { i++; ws(); return i === text.length ? out : null; }
  for (;;) {
    ws();
    const k = str();
    ws();
    if (k === null || text[i++] !== ":") return null;
    ws();
    const v = str();
    if (v === null) return null;
    out.push([k, v]);
    ws();
    const c = text[i++];
    if (c === "}") break;
    if (c !== ",") return null;
  }
  ws();
  return i === text.length ? out : null;
}

// checkManifest returns "ok" or the refusal reason of the relay for the manifest bytes.
export function checkManifest(bytes, pins) {
  if (bytes.length > MAX_BYTES) return "shape";
  let pairs;
  try { pairs = readObject(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { return "shape"; }
  if (pairs === null) return "shape";
  const seen = new Set();
  for (const [k, v] of pairs) {
    if (seen.has(k) || !/^[0-9a-f]{40}$/.test(v)) return "shape";
    if (seen.size === MAX_ENTRIES) return "too_many";
    seen.add(k);
  }
  for (const [path, hash] of pairs) {
    const m = /^([^/]+)\.lproj\/pass\.strings$/.exec(path);
    if (path === "pass.json" || (m && LOCALES.includes(m[1]))) continue;
    if (PINNED.includes(path)) { if (!(pins[path] ?? []).includes(hash)) return "foreign_asset"; continue; }
    return "unknown_file";
  }
  for (const req of ["pass.json", "icon.png"]) if (!seen.has(req)) return "missing_file";
  return "ok";
}

// ---- Deterministic test keys and certificates ---------------------------------------------------------

const SMALL = (() => { const s = []; for (let n = 3; n < 2000; n += 2) if (s.every((p) => n % p)) s.push(n); return s.map(BigInt); })();
const BASES = [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n, 41n, 43n, 47n, 53n, 59n, 61n, 67n, 71n];

function modPow(b, e, m) {
  let r = 1n;
  b %= m;
  while (e > 0n) { if (e & 1n) r = (r * b) % m; b = (b * b) % m; e >>= 1n; }
  return r;
}

function probablePrime(n) {
  for (const p of SMALL) if (n % p === 0n) return n === p;
  let d = n - 1n, r = 0;
  while ((d & 1n) === 0n) { d >>= 1n; r++; }
  outer: for (const a of BASES) {
    let x = modPow(a, d, n);
    if (x === 1n || x === n - 1n) continue;
    for (let i = 1; i < r; i++) { x = (x * x) % n; if (x === n - 1n) continue outer; }
    return false;
  }
  return true;
}

const gcd = (a, b) => { while (b) [a, b] = [b, a % b]; return a; };
const modInv = (a, m) => { let [r0, r1, s0, s1] = [a, m, 1n, 0n]; while (r1) { const q = r0 / r1; [r0, r1] = [r1, r0 - q * r1]; [s0, s1] = [s1, s0 - q * s1]; } return ((s0 % m) + m) % m; };

// stream is SHA-256(seed || label || uint32be(i)) for i = 0, 1, ..., cut to n bytes.
function stream(seed, label, n) {
  const out = [];
  for (let i = 0; Buffer.concat(out).length < n; i++) {
    const c = Buffer.alloc(4); c.writeUInt32BE(i);
    out.push(crypto.createHash("sha256").update(seed).update(label).update(c).digest());
  }
  return Buffer.concat(out).subarray(0, n);
}

// derivePrime: a 1024-bit candidate from the stream with the two top bits and the low bit set, then the
// first c, c+2, c+4, ... that is a probable prime with gcd(c-1, 65537) = 1.
function derivePrime(seed, label) {
  let c = BigInt("0x" + stream(seed, label, 128).toString("hex")) | (3n << 1022n) | 1n;
  while (!(probablePrime(c) && gcd(c - 1n, 65537n) === 1n)) c += 2n;
  return c;
}

// deriveRSAKey derives a 2048-bit RSA key from seed: p from label "p", q from label "q", e = 65537. Only for
// test vectors: a seed in a public file is no secret.
export function deriveRSAKey(seed) {
  const p = derivePrime(seed, "p"), q = derivePrime(seed, "q"), e = 65537n, n = p * q;
  const d = modInv(e, (p - 1n) * (q - 1n));
  const b = (v) => bigToBytes(v).toString("base64url");
  const jwk = { kty: "RSA", n: b(n), e: b(e), d: b(d), p: b(p), q: b(q), dp: b(d % (p - 1n)), dq: b(d % (q - 1n)), qi: b(modInv(q, p)) };
  return { n, e, privateKey: crypto.createPrivateKey({ key: jwk, format: "jwk" }) };
}

const rsaPublicKey = (k) => tlv(0x30, integer(k.n), integer(k.e));
const keyID = (k) => crypto.createHash("sha1").update(rsaPublicKey(k)).digest();

function name(attrs) {
  return tlv(0x30, ...attrs.map(([o, v, printable]) =>
    tlv(0x31, tlv(0x30, oid(o), tlv(printable ? 0x13 : 0x0c, Buffer.from(v, "utf8"))))));
}

function extension(o, critical, value) {
  return tlv(0x30, oid(o), ...(critical ? [Buffer.from([0x01, 0x01, 0xff])] : []), tlv(0x04, value));
}

// certificate writes an X.509 v3 certificate signed with sha256WithRSAEncryption by issuerKey.
export function certificate({ serial, subject, issuer, notBefore, notAfter, key, issuerKey, ca }) {
  const exts = [
    extension("2.5.29.19", ca, tlv(0x30, ...(ca ? [Buffer.from([0x01, 0x01, 0xff])] : []))),
    extension("2.5.29.15", true, ca ? Buffer.from([0x03, 0x02, 0x01, 0x06]) : Buffer.from([0x03, 0x02, 0x07, 0x80])),
    extension("2.5.29.14", false, tlv(0x04, keyID(key))),
  ];
  if (issuerKey !== key) exts.push(extension("2.5.29.35", false, tlv(0x30, tlv(0x80, keyID(issuerKey)))));
  const spki = tlv(0x30, algorithm(OID.rsaEncryption), tlv(0x03, Buffer.from([0]), rsaPublicKey(key)));
  const tbs = tlv(0x30, tlv(0xa0, integer(2)), integer(serial), algorithm(OID.sha256WithRSA), name(issuer),
    tlv(0x30, utcTime(notBefore), utcTime(notAfter)), name(subject), spki, tlv(0xa3, tlv(0x30, ...exts)));
  const sig = crypto.sign("sha256", tbs, { key: issuerKey.privateKey, padding: crypto.constants.RSA_PKCS1_PADDING });
  return tlv(0x30, tbs, algorithm(OID.sha256WithRSA), tlv(0x03, Buffer.from([0]), sig));
}
