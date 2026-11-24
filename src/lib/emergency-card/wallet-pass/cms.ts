/**
 * The signature of a `.pkpass` made on this instance (v1.50), for operators
 * who sign with their own Pass Type ID: a detached CMS `SignedData` over the
 * exact bytes of `manifest.json`, written in DER with `node:crypto` alone.
 *
 *   ContentInfo { signedData, SignedData {
 *     version 1, digestAlgorithms { sha256 },
 *     encapContentInfo { data } (detached: no content),
 *     certificates [ signer, intermediate (Apple WWDR) ],
 *     signerInfos [ { version 1, issuerAndSerialNumber, sha256,
 *       signedAttrs { contentType = data, signingTime, messageDigest },
 *       rsaEncryption, signature } ] } }
 *
 * The signed attributes are a DER SET, so they are sorted by their encoding;
 * the signature is RSA PKCS#1 v1.5 over that SET with its universal tag.
 * Given the same key, certificates, manifest and signing time, the output is
 * the same bytes, which the tests rely on.
 */
import {
  createHash,
  createPrivateKey,
  KeyObject,
  sign,
  X509Certificate,
} from "node:crypto";

const OID = {
  data: "1.2.840.113549.1.7.1",
  signedData: "1.2.840.113549.1.7.2",
  sha256: "2.16.840.1.101.3.4.2.1",
  rsaEncryption: "1.2.840.113549.1.1.1",
  contentType: "1.2.840.113549.1.9.3",
  messageDigest: "1.2.840.113549.1.9.4",
  signingTime: "1.2.840.113549.1.9.5",
} as const;

function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, ...content: Buffer[]): Buffer {
  const body = Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
}

const seq = (...c: Buffer[]) => tlv(0x30, ...c);
const set = (...c: Buffer[]) => tlv(0x31, ...c);
const nul = () => Buffer.from([0x05, 0x00]);
const int = (n: number) => tlv(0x02, Buffer.from([n]));
const octets = (b: Buffer) => tlv(0x04, b);

function oid(dotted: string): Buffer {
  const parts = dotted.split(".").map(Number);
  const bytes = [parts[0] * 40 + parts[1]];
  for (const part of parts.slice(2)) {
    const chunk: number[] = [part & 0x7f];
    for (let v = part >> 7; v > 0; v >>= 7) chunk.unshift((v & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

/** DER SET OF: the elements sorted by their encodings. */
function setOf(elements: Buffer[]): Buffer {
  return set(...[...elements].sort(Buffer.compare));
}

function utcTime(date: Date): Buffer {
  const year = date.getUTCFullYear();
  if (year < 1950 || year > 2049) throw new Error("signing time out of range");
  const two = (n: number) => String(n).padStart(2, "0");
  const text =
    two(year % 100) +
    two(date.getUTCMonth() + 1) +
    two(date.getUTCDate()) +
    two(date.getUTCHours()) +
    two(date.getUTCMinutes()) +
    two(date.getUTCSeconds()) +
    "Z";
  return tlv(0x17, Buffer.from(text, "ascii"));
}

/** One DER element at `offset`: its tag, where its content is, its end. */
function readTlv(der: Buffer, offset: number) {
  const tag = der[offset];
  let len = der[offset + 1];
  let head = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + der[offset + 2 + i];
    head += n;
  }
  return { tag, start: offset + head, end: offset + head + len };
}

/**
 * The certificate's issuer Name and serial number INTEGER, as the DER bytes
 * they are in the certificate (the signer is identified by both).
 */
function issuerAndSerial(cert: X509Certificate): Buffer {
  const der = cert.raw;
  const certificate = readTlv(der, 0);
  const tbs = readTlv(der, certificate.start);
  let at = tbs.start;
  let field = readTlv(der, at);
  if (field.tag === 0xa0) {
    at = field.end; // explicit version
    field = readTlv(der, at);
  }
  const serial = der.subarray(at, field.end);
  const algorithm = readTlv(der, field.end);
  const issuerAt = algorithm.end;
  const issuer = der.subarray(issuerAt, readTlv(der, issuerAt).end);
  return seq(issuer, serial);
}

export interface LocalSigner {
  /** The pass certificate, PEM. */
  certificatePem: string;
  /** Its private key: a key object, or PKCS#8 PEM without a password. RSA. */
  privateKey: KeyObject | string;
  /** The intermediate that issued it (Apple WWDR), PEM. */
  intermediatePem: string;
}

/** The detached CMS signature over `manifest`, DER. */
export function signManifestLocally(
  manifest: Uint8Array,
  signer: LocalSigner,
  signingTime: Date = new Date(),
): Uint8Array {
  const cert = new X509Certificate(signer.certificatePem);
  const intermediate = new X509Certificate(signer.intermediatePem);
  const key =
    signer.privateKey instanceof KeyObject
      ? signer.privateKey
      : createPrivateKey(signer.privateKey);
  if (key.asymmetricKeyType !== "rsa") {
    throw new Error("a pass certificate key is RSA");
  }
  if (!cert.checkPrivateKey(key)) {
    throw new Error("the key does not belong to the pass certificate");
  }

  const sha256 = seq(oid(OID.sha256), nul());
  const digest = createHash("sha256").update(manifest).digest();
  const attributes = [
    seq(oid(OID.contentType), set(oid(OID.data))),
    seq(oid(OID.signingTime), set(utcTime(signingTime))),
    seq(oid(OID.messageDigest), set(octets(digest))),
  ];
  const signedAttrs = setOf(attributes);
  const signature = sign("sha256", signedAttrs, key);

  const signerInfo = seq(
    int(1),
    issuerAndSerial(cert),
    sha256,
    // The same SET under the context tag [0] IMPLICIT.
    Buffer.concat([Buffer.from([0xa0]), signedAttrs.subarray(1)]),
    seq(oid(OID.rsaEncryption), nul()),
    octets(signature),
  );
  const signedData = seq(
    int(1),
    set(sha256),
    seq(oid(OID.data)),
    tlv(0xa0, cert.raw, intermediate.raw),
    set(signerInfo),
  );
  return new Uint8Array(seq(oid(OID.signedData), tlv(0xa0, signedData)));
}
