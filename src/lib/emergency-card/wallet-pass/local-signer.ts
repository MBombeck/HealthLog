/**
 * Signing passes with the operator's own Pass Type ID (v1.50), read from the
 * `WALLET_APPLE_*` environment.
 *
 * By default a pass is signed by the project's signing service over the push
 * relay (`sign.ts`). An operator with an Apple developer account can sign on
 * this server instead: four variables, all or none.
 *
 *   WALLET_APPLE_PASS_TYPE_ID    pass.org.example.emergency
 *   WALLET_APPLE_TEAM_ID         the 10-character team, the certificate's OU
 *   WALLET_APPLE_CERT_B64        the Pass Type ID certificate, PEM or DER, base64
 *   WALLET_APPLE_KEY_B64         its RSA private key, PEM, base64
 *   WALLET_APPLE_KEY_PASSPHRASE  optional: the key's passphrase
 *   WALLET_APPLE_WWDR_B64        optional: the intermediate, else Apple WWDR G4
 *
 * Fail closed: a partial set or one that does not hold together (the key does
 * not belong to the certificate, Apple's intermediate did not issue it, the
 * certificate names another Pass Type ID or team, or it has fewer than seven
 * days left) makes Wallet unavailable on this server. It never falls back to
 * the project's signing service, which would sign under an identity the
 * operator did not choose. What went wrong is a closed code; no value of a
 * variable is ever logged or returned.
 */
import { createHash, createPrivateKey, X509Certificate } from "node:crypto";

import type { LocalSigner } from "./cms";
import { appleWwdrG4 } from "./wwdr";

/** The four variables that switch local signing on, all or none. */
export const WALLET_APPLE_REQUIRED_ENV = [
  "WALLET_APPLE_PASS_TYPE_ID",
  "WALLET_APPLE_TEAM_ID",
  "WALLET_APPLE_CERT_B64",
  "WALLET_APPLE_KEY_B64",
] as const;
export const WALLET_APPLE_OPTIONAL_ENV = [
  "WALLET_APPLE_KEY_PASSPHRASE",
  "WALLET_APPLE_WWDR_B64",
] as const;

/** How long the certificate must still be valid to sign with it. */
export const LOCAL_CERT_MIN_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;
const PASS_TYPE_ID = /^pass\.[A-Za-z0-9.-]{1,120}$/;
const TEAM_ID = /^[A-Z0-9]{10}$/;

export type LocalSignerProblem =
  | "incomplete"
  | "pass_type_id"
  | "team_id"
  | "certificate"
  | "intermediate"
  | "key"
  | "key_mismatch"
  | "issuer"
  | "identifier_mismatch"
  | "not_yet_valid"
  | "expiring";

export interface LocalWalletIdentity {
  passTypeIdentifier: string;
  teamIdentifier: string;
  /** `O=` of the certificate, shown as the pass's signer. */
  organization: string;
  certNotAfter: Date;
  signer: LocalSigner;
}

export type LocalWalletConfig =
  | { state: "off" }
  | { state: "invalid"; problem: LocalSignerProblem }
  | { state: "ready"; identity: LocalWalletIdentity };

type Env = Partial<Record<string, string | undefined>>;

const value = (env: Env, name: string) => (env[name] ?? "").trim();

function decodeB64(text: string): Buffer | null {
  const compact = text.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(compact)) return null;
  const bytes = Buffer.from(compact, "base64");
  return bytes.length > 0 ? bytes : null;
}

function certificate(bytes: Buffer | null): X509Certificate | null {
  if (!bytes) return null;
  try {
    return new X509Certificate(bytes);
  } catch {
    return null;
  }
}

function pem(cert: X509Certificate): string {
  const body = cert.raw.toString("base64").replace(/(.{64})/g, "$1\n");
  return `-----BEGIN CERTIFICATE-----\n${body.replace(/\n$/, "")}\n-----END CERTIFICATE-----\n`;
}

/** One attribute of a subject, as Node prints it (`KEY=value` per line). */
function subjectAttribute(cert: X509Certificate, key: string): string[] {
  return cert.subject
    .split("\n")
    .filter((line) => line.startsWith(`${key}=`))
    .map((line) => line.slice(key.length + 1));
}

/** Read and check the environment. Pure apart from parsing the key. */
export function readLocalWalletConfig(
  env: Env = process.env,
  now: Date = new Date(),
): LocalWalletConfig {
  const set = WALLET_APPLE_REQUIRED_ENV.filter((n) => value(env, n) !== "");
  const anyOptional = WALLET_APPLE_OPTIONAL_ENV.some(
    (n) => value(env, n) !== "",
  );
  if (set.length === 0 && !anyOptional) return { state: "off" };
  const invalid = (problem: LocalSignerProblem): LocalWalletConfig => ({
    state: "invalid",
    problem,
  });
  if (set.length !== WALLET_APPLE_REQUIRED_ENV.length) {
    return invalid("incomplete");
  }

  const passTypeIdentifier = value(env, "WALLET_APPLE_PASS_TYPE_ID");
  const teamIdentifier = value(env, "WALLET_APPLE_TEAM_ID");
  if (!PASS_TYPE_ID.test(passTypeIdentifier)) return invalid("pass_type_id");
  if (!TEAM_ID.test(teamIdentifier)) return invalid("team_id");

  const cert = certificate(decodeB64(value(env, "WALLET_APPLE_CERT_B64")));
  if (!cert) return invalid("certificate");
  const wwdrB64 = value(env, "WALLET_APPLE_WWDR_B64");
  const intermediate = wwdrB64
    ? certificate(decodeB64(wwdrB64))
    : appleWwdrG4();
  if (!intermediate) return invalid("intermediate");

  const keyBytes = decodeB64(value(env, "WALLET_APPLE_KEY_B64"));
  if (!keyBytes) return invalid("key");
  const passphrase = value(env, "WALLET_APPLE_KEY_PASSPHRASE");
  let key;
  try {
    key = createPrivateKey({
      key: keyBytes,
      format: "pem",
      ...(passphrase ? { passphrase } : {}),
    });
  } catch {
    return invalid("key");
  }
  if (
    key.asymmetricKeyType !== "rsa" ||
    (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
  ) {
    return invalid("key");
  }
  if (!cert.checkPrivateKey(key)) return invalid("key_mismatch");
  if (!cert.checkIssued(intermediate) || !cert.verify(intermediate.publicKey)) {
    return invalid("issuer");
  }
  const uid = subjectAttribute(cert, "UID");
  const ou = subjectAttribute(cert, "OU");
  if (
    uid.length !== 1 ||
    uid[0] !== passTypeIdentifier ||
    ou.length !== 1 ||
    ou[0] !== teamIdentifier
  ) {
    return invalid("identifier_mismatch");
  }
  const notBefore = new Date(cert.validFrom);
  const notAfter = new Date(cert.validTo);
  if (now.getTime() < notBefore.getTime()) return invalid("not_yet_valid");
  if (notAfter.getTime() - now.getTime() < LOCAL_CERT_MIN_DAYS * DAY_MS) {
    return invalid("expiring");
  }

  return {
    state: "ready",
    identity: {
      passTypeIdentifier,
      teamIdentifier,
      organization: subjectAttribute(cert, "O")[0] ?? passTypeIdentifier,
      certNotAfter: notAfter,
      signer: {
        certificatePem: pem(cert),
        privateKey: key,
        intermediatePem: pem(intermediate),
      },
    },
  };
}

let cached: { fingerprint: string; day: number; config: LocalWalletConfig } = {
  fingerprint: "",
  day: -1,
  config: { state: "off" },
};

/**
 * The configuration of this process, read once and again only when a
 * variable changes or a day passes (the expiry check is per day). The cache
 * key is a hash of the values, never the values.
 */
export function localWalletConfig(
  env: Env = process.env,
  now: Date = new Date(),
): LocalWalletConfig {
  const hash = createHash("sha256");
  for (const n of [
    ...WALLET_APPLE_REQUIRED_ENV,
    ...WALLET_APPLE_OPTIONAL_ENV,
  ]) {
    hash.update(`${n}\n${value(env, n)}\n`);
  }
  const fingerprint = hash.digest("hex");
  const day = Math.floor(now.getTime() / DAY_MS);
  if (cached.fingerprint !== fingerprint || cached.day !== day) {
    cached = { fingerprint, day, config: readLocalWalletConfig(env, now) };
  }
  return cached.config;
}
