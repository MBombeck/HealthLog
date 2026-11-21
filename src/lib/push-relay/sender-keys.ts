/**
 * The sender keys this server seals push envelopes with.
 *
 * One X25519 pair, its private half encrypted at rest with
 * `src/lib/crypto.ts`, rotated every 30 days. The previous public key stays
 * published as `previous` for 30 days after a rotation, so a device that has
 * not refreshed its pins in that time still opens what was sealed before, and
 * a device never trusts more than two sender keys. Every seal uses the
 * current key. An emergency rotation (`rotateSenderKey({ emergency: true })`)
 * drops the previous key at once.
 *
 * The same row holds the secret the per-device collapse ids are derived from
 * (`collapseIdFor`): the HMAC over the device token makes the id differ per
 * device, so neither the relay nor Apple can link the devices of one person
 * through equal collapse ids.
 */
import { createHmac, randomBytes } from "node:crypto";

import { prisma } from "@/lib/db";
import { decrypt, encrypt } from "@/lib/crypto";
import { fromBase64Url, fromHex, toBase64Url } from "@/lib/push-relay/encoding";
import { generateX25519 } from "@/lib/push-relay/hpke";

export const SENDER_KEY_ROTATION_DAYS = 30;
export const PREVIOUS_SENDER_KEY_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface SenderKeyMaterial {
  senderPrivateKey: Buffer;
  collapseSecret: Buffer;
}

export interface PublishedSenderKey {
  publicKey: string;
  status: "current" | "previous";
}

function freshRow(now: Date) {
  const pair = generateX25519();
  return {
    senderKeyEncrypted: encrypt(toBase64Url(pair.privateKey)),
    senderPublicKey: toBase64Url(pair.publicKey),
    senderCreatedAt: now,
  };
}

/** The key row, created on first use. */
export async function ensureEnvelopeKeys(now: Date = new Date()) {
  const existing = await prisma.pushEnvelopeKeys.findUnique({
    where: { id: "singleton" },
  });
  if (existing) return existing;
  return prisma.pushEnvelopeKeys.upsert({
    where: { id: "singleton" },
    create: {
      id: "singleton",
      ...freshRow(now),
      collapseSecretEncrypted: encrypt(toBase64Url(randomBytes(32))),
    },
    update: {},
  });
}

/** The private material for sealing; null when no key row exists. */
export async function loadSenderKeyMaterial(): Promise<SenderKeyMaterial | null> {
  const row = await prisma.pushEnvelopeKeys.findUnique({
    where: { id: "singleton" },
    select: { senderKeyEncrypted: true, collapseSecretEncrypted: true },
  });
  if (!row) return null;
  const senderPrivateKey = fromBase64Url(decrypt(row.senderKeyEncrypted), 32);
  const collapseSecret = fromBase64Url(
    decrypt(row.collapseSecretEncrypted),
    32,
  );
  if (!senderPrivateKey || !collapseSecret) return null;
  return { senderPrivateKey, collapseSecret };
}

/** The sender keys a device pins: current, and previous while it lasts. */
export function publishedSenderKeys(
  row: {
    senderPublicKey: string;
    previousSenderPublicKey: string | null;
    previousRetiredAt: Date | null;
  } | null,
  now: Date = new Date(),
): PublishedSenderKey[] {
  if (!row) return [];
  const keys: PublishedSenderKey[] = [
    { publicKey: row.senderPublicKey, status: "current" },
  ];
  if (
    row.previousSenderPublicKey &&
    row.previousRetiredAt &&
    now.getTime() - row.previousRetiredAt.getTime() <
      PREVIOUS_SENDER_KEY_DAYS * DAY_MS
  ) {
    keys.push({ publicKey: row.previousSenderPublicKey, status: "previous" });
  }
  return keys;
}

/** Whether the current sender key is due for its 30-day rotation. */
export function senderKeyDue(
  row: { senderCreatedAt: Date },
  now: Date = new Date(),
): boolean {
  return (
    now.getTime() - row.senderCreatedAt.getTime() >=
    SENDER_KEY_ROTATION_DAYS * DAY_MS
  );
}

/**
 * Replace the current sender key. The old public key becomes `previous`
 * unless `emergency`, which drops it so devices stop trusting it at their next
 * `/api/auth/me`. Returns false when there is no key row to rotate.
 */
export async function rotateSenderKey(
  options: { emergency?: boolean; now?: Date } = {},
): Promise<boolean> {
  const now = options.now ?? new Date();
  const row = await prisma.pushEnvelopeKeys.findUnique({
    where: { id: "singleton" },
    select: { senderPublicKey: true },
  });
  if (!row) return false;
  await prisma.pushEnvelopeKeys.update({
    where: { id: "singleton" },
    data: {
      ...freshRow(now),
      previousSenderPublicKey: options.emergency ? null : row.senderPublicKey,
      previousRetiredAt: options.emergency ? null : now,
    },
  });
  return true;
}

/** Drop every sender key; devices stop opening anything at their next pin. */
export async function deleteEnvelopeKeys(): Promise<void> {
  await prisma.pushEnvelopeKeys.deleteMany({ where: { id: "singleton" } });
}

/**
 * The relay collapse id of one push for one device: the first 22 characters
 * of `base64url(HMAC-SHA256(secret, token || key))`.
 */
export function collapseIdFor(
  secret: Buffer,
  apnsTokenHex: string,
  key: string,
): string {
  const token = fromHex(apnsTokenHex) ?? Buffer.alloc(0);
  return createHmac("sha256", secret)
    .update(Buffer.concat([token, Buffer.from(key, "utf8")]))
    .digest("base64url")
    .slice(0, 22);
}
