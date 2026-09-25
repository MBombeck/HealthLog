/**
 * v1.23 — passphrase-encrypted export archive (`HLX1` wire format).
 *
 * A user can choose to download their export as an encrypted archive instead
 * of plaintext JSON. The passphrase the user supplies is run through Argon2id
 * to derive a 256-bit key, and the export bytes are sealed with AES-256-GCM.
 *
 * THREAT MODEL. The data is already plaintext-at-rest on the server (the
 * server computes insights / rollups / FHIR over it). What this closes is the
 * "plaintext health file lands in Downloads / iCloud / Google-Drive sync"
 * path: the file that leaves the server is opaque without the passphrase.
 * There is NO server-side recovery — the passphrase is never stored and never
 * logged, so a forgotten passphrase means the archive is unrecoverable. The
 * UI states this loudly.
 *
 * Wire format (binary), mirroring the off-host backup `HLBK` envelope so there
 * is one decryption mental model in the codebase + docs:
 *
 *   magic(4)      = "HLX1"
 *   version(1)    = 0x01
 *   kdf(1)        = 0x01            (Argon2id)
 *   memoryCost(4) = uint32 BE       (KiB; Argon2 `m`)
 *   timeCost(4)   = uint32 BE       (Argon2 `t`)
 *   parallelism(1)= uint8           (Argon2 `p`)
 *   saltLen(1)    = uint8           (= 16)
 *   salt(saltLen)
 *   iv(12)                          (AES-GCM nonce)
 *   tag(16)                         (AES-GCM auth tag)
 *   ciphertext(...)
 *
 * The Argon2 params travel in the header (self-describing) so a future cost
 * bump still decrypts every previously-written archive — the decryptor reads
 * `m/t/p` + `salt` from the file, never from a constant. The standalone
 * `scripts/decrypt-export.ts` decryptor depends ONLY on this module, so a user
 * can open the archive with `pnpm dlx tsx` and their passphrase, app or not.
 *
 * KDF defaults are the 2025 OWASP minimum for Argon2id (RFC 9106):
 * 19 MiB / t=2 / p=1, 32-byte output. Kept independent from the password
 * hashing params so tuning one never silently changes the other.
 */
import { hashRaw, type Algorithm } from "@node-rs/argon2";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const MAGIC = "HLX1";
const VERSION = 0x01;
const KDF_ARGON2ID = 0x01;
// `Algorithm.Argon2id` is a const enum (= 2); reference the value directly so
// the module compiles under `isolatedModules` without importing the enum.
const ARGON2ID: Algorithm = 2 as Algorithm;

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const SALT_LENGTH = 16;
const KEY_LENGTH = 32;

/**
 * Argon2id KDF parameters for newly-written archives. OWASP-minimum for
 * 2025 (RFC 9106): 19 MiB memory, 2 passes, single lane, 32-byte key.
 * These are written into each archive header, so changing them never
 * orphans archives written under the old cost.
 */
export const EXPORT_ARGON2_PARAMS = {
  /** Argon2 `m` — memory cost in KiB (19 MiB). */
  memoryCost: 19456,
  /** Argon2 `t` — iterations. */
  timeCost: 2,
  /** Argon2 `p` — lanes. */
  parallelism: 1,
} as const;

/**
 * Minimum passphrase length the encrypt path enforces. A short passphrase
 * defeats the KDF; 12 mirrors the account password floor.
 */
export const MIN_EXPORT_PASSPHRASE_LENGTH = 12;

export interface ArchiveHeader {
  version: number;
  kdf: number;
  memoryCost: number;
  timeCost: number;
  parallelism: number;
  salt: Buffer;
}

/** Derive the 256-bit AES key from a passphrase + the archive's KDF params. */
async function deriveKey(
  passphrase: string,
  params: { memoryCost: number; timeCost: number; parallelism: number },
  salt: Buffer,
): Promise<Buffer> {
  return hashRaw(passphrase, {
    algorithm: ARGON2ID,
    memoryCost: params.memoryCost,
    timeCost: params.timeCost,
    parallelism: params.parallelism,
    outputLen: KEY_LENGTH,
    salt,
  });
}

/**
 * Encrypt `plaintext` into an `HLX1` archive sealed with `passphrase`.
 * Throws if the passphrase is shorter than `MIN_EXPORT_PASSPHRASE_LENGTH`.
 */
export async function encryptArchive(
  plaintext: string | Buffer,
  passphrase: string,
): Promise<Buffer> {
  if (passphrase.length < MIN_EXPORT_PASSPHRASE_LENGTH) {
    throw new Error(
      `Passphrase must be at least ${MIN_EXPORT_PASSPHRASE_LENGTH} characters`,
    );
  }

  const salt = randomBytes(SALT_LENGTH);
  const key = await deriveKey(passphrase, EXPORT_ARGON2_PARAMS, salt);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const body =
    typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext;
  const ciphertext = Buffer.concat([cipher.update(body), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([archiveHeader(), salt, iv, tag, ciphertext]);
}

/** The fixed `HLX1` header for the current KDF parameters. */
function archiveHeader(): Buffer {
  const header = Buffer.alloc(4 + 1 + 1 + 4 + 4 + 1 + 1);
  header.write(MAGIC, 0, "ascii");
  header.writeUInt8(VERSION, 4);
  header.writeUInt8(KDF_ARGON2ID, 5);
  header.writeUInt32BE(EXPORT_ARGON2_PARAMS.memoryCost, 6);
  header.writeUInt32BE(EXPORT_ARGON2_PARAMS.timeCost, 10);
  header.writeUInt8(EXPORT_ARGON2_PARAMS.parallelism, 14);
  header.writeUInt8(SALT_LENGTH, 15);
  return header;
}

/** Where `encryptArchiveToFile` left an archive, in two parts. */
export interface SpooledArchive {
  /** Header, salt, IV and tag: everything in front of the ciphertext. */
  prefix: Buffer;
  /** File holding the ciphertext, which follows the prefix. */
  bodyPath: string;
  /** Size of the whole archive in bytes. */
  byteLength: number;
}

/**
 * Seal a JSON document produced in pieces into an `HLX1` archive without
 * holding it: the ciphertext goes to `bodyPath` as it is produced.
 *
 * Why a file. The format puts the GCM tag in front of the ciphertext, and the
 * tag exists only once the last byte has been encrypted, so the archive
 * cannot be sent as it is written. Holding it in memory instead is what the
 * route did, and for an account of 1.25 million measurements that did not fit
 * a 1 GB container (#1031). Spooling the ciphertext keeps the format, so every
 * archive already on someone's disk still opens the same way. Only ciphertext
 * ever touches the disk; the caller deletes the file once it is sent.
 *
 * Decrypts with `decryptArchive` exactly like an archive `encryptArchive`
 * wrote; the tests hold the two to that.
 */
export async function encryptArchiveToFile(
  producer: (
    write: (chunk: string | Buffer) => Promise<void>,
  ) => Promise<unknown>,
  passphrase: string,
  bodyPath: string,
): Promise<SpooledArchive> {
  if (passphrase.length < MIN_EXPORT_PASSPHRASE_LENGTH) {
    throw new Error(
      `Passphrase must be at least ${MIN_EXPORT_PASSPHRASE_LENGTH} characters`,
    );
  }
  const salt = randomBytes(SALT_LENGTH);
  const key = await deriveKey(passphrase, EXPORT_ARGON2_PARAMS, salt);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const file = createWriteStream(bodyPath, { mode: 0o600 });
  let bodyBytes = 0;
  const fileError = new Promise<never>((_, reject) => {
    file.once("error", reject);
  });
  fileError.catch(() => {});

  const put = async (bytes: Buffer): Promise<void> => {
    if (bytes.length === 0) return;
    bodyBytes += bytes.length;
    if (!file.write(bytes)) {
      await Promise.race([once(file, "drain"), fileError]);
    }
  };

  try {
    await producer(async (chunk) => {
      await put(
        cipher.update(
          typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk,
        ),
      );
    });
    await put(cipher.final());
    file.end();
    await Promise.race([once(file, "finish"), fileError]);
  } catch (err) {
    file.destroy();
    throw err;
  }

  const prefix = Buffer.concat([
    archiveHeader(),
    salt,
    iv,
    cipher.getAuthTag(),
  ]);
  return { prefix, bodyPath, byteLength: prefix.length + bodyBytes };
}

/** Parse + validate the fixed `HLX1` header. Throws on any structural fault. */
export function parseArchiveHeader(buf: Buffer): {
  header: ArchiveHeader;
  bodyOffset: number;
} {
  if (buf.length < 16) {
    throw new Error("Not an HLX1 archive (too short)");
  }
  const magic = buf.subarray(0, 4).toString("ascii");
  if (!timingSafeEqual(Buffer.from(magic), Buffer.from(MAGIC))) {
    throw new Error("Not an HLX1 archive (bad magic)");
  }
  const version = buf.readUInt8(4);
  if (version !== VERSION) {
    throw new Error(`Unsupported HLX1 version ${version}`);
  }
  const kdf = buf.readUInt8(5);
  if (kdf !== KDF_ARGON2ID) {
    throw new Error(`Unsupported KDF id ${kdf}`);
  }
  const memoryCost = buf.readUInt32BE(6);
  const timeCost = buf.readUInt32BE(10);
  const parallelism = buf.readUInt8(14);
  const saltLen = buf.readUInt8(15);
  const saltStart = 16;
  const ivStart = saltStart + saltLen;
  const tagStart = ivStart + IV_LENGTH;
  const bodyOffset = tagStart + TAG_LENGTH;
  if (buf.length < bodyOffset) {
    throw new Error("Corrupt HLX1 archive (truncated header)");
  }
  if (memoryCost < 1 || timeCost < 1 || parallelism < 1 || saltLen < 8) {
    throw new Error("Corrupt HLX1 archive (implausible KDF params)");
  }
  return {
    header: {
      version,
      kdf,
      memoryCost,
      timeCost,
      parallelism,
      salt: buf.subarray(saltStart, ivStart),
    },
    bodyOffset,
  };
}

/**
 * Decrypt an `HLX1` archive with `passphrase`. A wrong passphrase fails the
 * GCM authentication tag and throws a clean, generic error (no oracle about
 * which part was wrong). The returned value is the original plaintext (UTF-8).
 */
export async function decryptArchive(
  buf: Buffer,
  passphrase: string,
): Promise<string> {
  const { header, bodyOffset } = parseArchiveHeader(buf);
  const saltLen = header.salt.length;
  const ivStart = 16 + saltLen;
  const tagStart = ivStart + IV_LENGTH;
  const iv = buf.subarray(ivStart, tagStart);
  const tag = buf.subarray(tagStart, bodyOffset);
  const ciphertext = buf.subarray(bodyOffset);

  const key = await deriveKey(
    passphrase,
    {
      memoryCost: header.memoryCost,
      timeCost: header.timeCost,
      parallelism: header.parallelism,
    },
    Buffer.from(header.salt),
  );

  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    const out = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return out.toString("utf8");
  } catch {
    // GCM tag mismatch — wrong passphrase or a tampered/corrupt archive.
    // Deliberately opaque: never reveal which.
    throw new Error("Decryption failed — wrong passphrase or corrupt archive");
  }
}
