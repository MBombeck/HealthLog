/**
 * The sender keys this server seals push envelopes with.
 *
 * X25519 pairs, private halves encrypted at rest with `src/lib/crypto.ts`,
 * rolled out staged (`spec/envelope.md`, "Rotation"), so a device that has
 * not opened the app recently never gets an envelope sealed with a key it has
 * not pinned:
 *
 * 1. Announce: a year after the current key was made (less the 7 days), a new
 *    pair is published as `next` and seals nothing.
 * 2. Overlap: after at least 7 days as `next` it becomes `current` and seals
 *    every push; the old current becomes `previous`. Sealing only ever reads
 *    `current`, and the promotion is the only regular writer of it, so no
 *    push is sealed with a key that was not published as `next` for 7 days
 *    (`nextKeyNoticeServed`).
 * 3. Retire: 30 days later `previous` is deleted.
 *
 * At most three keys are published (`next`, `current`, `previous`): a `next`
 * is announced only once `previous` has retired. The only exceptions to the
 * notice are the first key of a server (nothing was pinned before it) and
 * the emergency rotation (`rotateSenderKey`, an audited operator action for a
 * key known to be exposed), which skips the announcement and drops
 * `previous` at once.
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

export const SENDER_KEY_ROTATION_DAYS = 365;
export const NEXT_SENDER_KEY_DAYS = 7;
export const PREVIOUS_SENDER_KEY_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface SenderKeyMaterial {
  senderPrivateKey: Buffer;
  collapseSecret: Buffer;
}

export interface PublishedSenderKey {
  publicKey: string;
  status: "next" | "current" | "previous";
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

/** The sender keys a device pins: next, current, and previous while it lasts. */
export function publishedSenderKeys(
  row: {
    senderPublicKey: string;
    nextSenderPublicKey?: string | null;
    previousSenderPublicKey: string | null;
    previousRetiredAt: Date | null;
  } | null,
  now: Date = new Date(),
): PublishedSenderKey[] {
  if (!row) return [];
  const keys: PublishedSenderKey[] = [];
  if (row.nextSenderPublicKey) {
    keys.push({ publicKey: row.nextSenderPublicKey, status: "next" });
  }
  keys.push({ publicKey: row.senderPublicKey, status: "current" });
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

/**
 * Whether the next key is due to be announced (a year less the overlap). Not
 * while a `previous` is still published: at most three keys at a time.
 */
export function senderKeyDue(
  row: {
    senderCreatedAt: Date;
    nextSenderPublicKey?: string | null;
    previousSenderPublicKey?: string | null;
  },
  now: Date = new Date(),
): boolean {
  return (
    !row.nextSenderPublicKey &&
    !row.previousSenderPublicKey &&
    now.getTime() - row.senderCreatedAt.getTime() >=
      (SENDER_KEY_ROTATION_DAYS - NEXT_SENDER_KEY_DAYS) * DAY_MS
  );
}

/**
 * Whether an announced key may seal: published as `next` for the full
 * notice. The one rule the promotion below is written against.
 */
export function nextKeyNoticeServed(
  nextAnnouncedAt: Date | null,
  now: Date = new Date(),
): boolean {
  return (
    nextAnnouncedAt !== null &&
    now.getTime() - nextAnnouncedAt.getTime() >= NEXT_SENDER_KEY_DAYS * DAY_MS
  );
}

export type SenderKeyStep = "announced" | "promoted" | "retired" | null;

/**
 * Move the staged rollout one step: retire a `previous` past its 30 days,
 * promote a `next` announced at least 7 days ago, or announce a `next` when
 * the current key is due. Returns what happened, at most one step per call.
 *
 * Every step is a compare-and-set on the row it read: two instances running
 * the minute pass at once take the step once. Without it, two announcements
 * racing each other replaced the `next` a device had already pinned with one
 * it never saw, and that key then sealed after its own notice only, which a
 * device that fetched in between never had.
 */
export async function advanceSenderKeys(
  now: Date = new Date(),
): Promise<SenderKeyStep> {
  const row = await prisma.pushEnvelopeKeys.findUnique({
    where: { id: "singleton" },
  });
  if (!row) return null;
  if (
    row.previousSenderPublicKey &&
    row.previousRetiredAt &&
    now.getTime() - row.previousRetiredAt.getTime() >=
      PREVIOUS_SENDER_KEY_DAYS * DAY_MS
  ) {
    const { count } = await prisma.pushEnvelopeKeys.updateMany({
      where: {
        id: "singleton",
        previousSenderPublicKey: row.previousSenderPublicKey,
      },
      data: { previousSenderPublicKey: null, previousRetiredAt: null },
    });
    return count === 1 ? "retired" : null;
  }
  if (
    row.nextSenderKeyEncrypted &&
    row.nextSenderPublicKey &&
    nextKeyNoticeServed(row.nextAnnouncedAt, now)
  ) {
    const { count } = await prisma.pushEnvelopeKeys.updateMany({
      where: {
        id: "singleton",
        senderPublicKey: row.senderPublicKey,
        nextSenderPublicKey: row.nextSenderPublicKey,
        nextAnnouncedAt: {
          lte: new Date(now.getTime() - NEXT_SENDER_KEY_DAYS * DAY_MS),
        },
      },
      data: {
        senderKeyEncrypted: row.nextSenderKeyEncrypted,
        senderPublicKey: row.nextSenderPublicKey,
        senderCreatedAt: now,
        previousSenderPublicKey: row.senderPublicKey,
        previousRetiredAt: now,
        nextSenderKeyEncrypted: null,
        nextSenderPublicKey: null,
        nextAnnouncedAt: null,
      },
    });
    return count === 1 ? "promoted" : null;
  }
  if (senderKeyDue(row, now)) {
    const pair = generateX25519();
    const { count } = await prisma.pushEnvelopeKeys.updateMany({
      where: {
        id: "singleton",
        senderPublicKey: row.senderPublicKey,
        nextSenderPublicKey: null,
        previousSenderPublicKey: null,
      },
      data: {
        nextSenderKeyEncrypted: encrypt(toBase64Url(pair.privateKey)),
        nextSenderPublicKey: toBase64Url(pair.publicKey),
        nextAnnouncedAt: now,
      },
    });
    return count === 1 ? "announced" : null;
  }
  return null;
}

/**
 * Emergency rotation, for a sender key known to be exposed: a new current
 * key at once, without an announcement, and the old current, an announced
 * next and the previous key dropped. Devices that have not fetched the new
 * key show the neutral placeholder until the app is opened.
 */
export async function rotateSenderKey(
  options: { now?: Date } = {},
): Promise<boolean> {
  const now = options.now ?? new Date();
  const row = await prisma.pushEnvelopeKeys.findUnique({
    where: { id: "singleton" },
    select: { id: true },
  });
  if (!row) return false;
  await prisma.pushEnvelopeKeys.update({
    where: { id: "singleton" },
    data: {
      ...freshRow(now),
      previousSenderPublicKey: null,
      previousRetiredAt: null,
      nextSenderKeyEncrypted: null,
      nextSenderPublicKey: null,
      nextAnnouncedAt: null,
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
