/**
 * A record's Apple Wallet pass, end to end (v1.50): what the owner's page and
 * the app may know about it, building its files, signing them, and
 * withdrawing it.
 *
 * The pass row holds no card content. Every download builds the pass again
 * from the record, for the items the pass's own link froze at creation, and
 * signs it anew. Before it is signed the content is compared with the stored
 * `contentHash`: when the card changed since the last build, `contentHash`
 * and `contentChangedAt` move on, so the "As of" date on the pass and the
 * `Last-Modified` of the download are true.
 *
 * A withdrawn pass is still served, in its withdrawn version: no QR code, no
 * name, no health data. That is what lets the app and Wallet replace the
 * installed pass with one that says it no longer counts.
 */
import { prisma } from "@/lib/db";
import { coerceLocale, type Locale } from "@/lib/i18n/config";
import { moodDateKey } from "@/lib/mood/date-key";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";

import { loadEmergencyCard } from "../card-data";
import type { EmergencyCardField } from "../fields";
import { cardLinkUrl } from "../manage";

import {
  assemblePkpass,
  buildPassFiles,
  passContentHash,
  passManifest,
  type PassFiles,
} from "./bundle";
import { WALLET_DOWNLOAD_PATH } from "./constants";
import { buildPassContent, type WalletSignerIdentity } from "./content";
import { openWalletLinkToken, walletAuthToken } from "./link-token";
import { enqueueWalletVoidPush } from "./queues";
import { voidWalletPassesWhere, type WalletPassVoidReason } from "./void";
import { signWalletManifest, walletSigningMode } from "./sign";

/** Downloads per pass and hour, shared with Wallet's own fetches. */
export const WALLET_FETCH_LIMIT_PER_HOUR = 30;
/** Passes made per person and hour. */
export const WALLET_MINT_LIMIT_PER_HOUR = 10;
export const WALLET_WINDOW_MS = 60 * 60 * 1000;

export type WalletPassState = "live" | "voided" | "expired";

export const WALLET_PASS_SELECT = {
  id: true,
  userId: true,
  createdById: true,
  signer: true,
  passTypeIdentifier: true,
  teamIdentifier: true,
  serialNumber: true,
  webServiceOrigin: true,
  contentHash: true,
  contentChangedAt: true,
  createdAt: true,
  voidedAt: true,
  voidReason: true,
  lastFetchedAt: true,
  link: {
    select: {
      id: true,
      fields: true,
      expiresAt: true,
      revokedAt: true,
      tokenEncrypted: true,
    },
  },
} as const;

export interface WalletPassRow {
  id: string;
  userId: string;
  createdById: string;
  signer: "RELAY" | "LOCAL";
  passTypeIdentifier: string;
  teamIdentifier: string;
  serialNumber: string;
  webServiceOrigin: string;
  contentHash: string;
  contentChangedAt: Date;
  createdAt: Date;
  voidedAt: Date | null;
  voidReason: WalletPassVoidReason | null;
  lastFetchedAt: Date | null;
  link: {
    id: string;
    fields: EmergencyCardField[];
    expiresAt: Date | null;
    revokedAt: Date | null;
    tokenEncrypted: string | null;
  };
}

export interface WalletPassSummary {
  serialNumber: string;
  state: WalletPassState;
  fields: EmergencyCardField[];
  createdAt: string;
  contentChangedAt: string;
  expiresAt: string | null;
  voidedAt: string | null;
  voidReason: Lowercase<WalletPassVoidReason> | null;
  lastFetchedAt: string | null;
  downloadPath: typeof WALLET_DOWNLOAD_PATH;
}

/**
 * When the pass stopped counting: its own stamp, else its link's. A link
 * ended by a credential remediation ends the pass with it, so the pass is
 * withdrawn from that moment even before its own row is stamped.
 */
export function walletPassVoidedAt(
  row: Pick<WalletPassRow, "voidedAt" | "link">,
): Date | null {
  return row.voidedAt ?? row.link.revokedAt;
}

export function walletPassState(
  row: Pick<WalletPassRow, "voidedAt" | "link">,
  now: Date = new Date(),
): WalletPassState {
  if (walletPassVoidedAt(row)) return "voided";
  const expires = row.link.expiresAt;
  return expires && expires.getTime() <= now.getTime() ? "expired" : "live";
}

export function toWalletPassSummary(
  row: WalletPassRow,
  now: Date = new Date(),
): WalletPassSummary {
  return {
    serialNumber: row.serialNumber,
    state: walletPassState(row, now),
    fields: row.link.fields,
    createdAt: row.createdAt.toISOString(),
    contentChangedAt: row.contentChangedAt.toISOString(),
    expiresAt: row.link.expiresAt?.toISOString() ?? null,
    voidedAt: walletPassVoidedAt(row)?.toISOString() ?? null,
    voidReason: row.voidReason
      ? (row.voidReason.toLowerCase() as Lowercase<WalletPassVoidReason>)
      : null,
    lastFetchedAt: row.lastFetchedAt?.toISOString() ?? null,
    downloadPath: WALLET_DOWNLOAD_PATH,
  };
}

/**
 * The record's newest pass, withdrawn or not, or null.
 *
 * One statement, the pass and its link joined in SQL: the relation select of
 * `WALLET_PASS_SELECT` costs Prisma a second statement, and this read rides
 * every `/api/auth/me` (the emergency card block), whose statement budget is
 * held by `query-budget-hot-routes.test.ts`. The columns are the ones
 * `WALLET_PASS_SELECT` names; `wallet-pass-latest-shape.test.ts` holds the two
 * lists together.
 */
export async function latestWalletPass(
  userId: string,
): Promise<WalletPassRow | null> {
  const rows = await prisma.$queryRaw<LatestPassRow[]>`
    SELECT wp.id, wp.user_id AS "userId", wp.created_by_id AS "createdById",
           wp.signer::text AS signer,
           wp.pass_type_identifier AS "passTypeIdentifier",
           wp.team_identifier AS "teamIdentifier",
           wp.serial_number AS "serialNumber",
           wp.web_service_origin AS "webServiceOrigin",
           wp.content_hash AS "contentHash",
           wp.content_changed_at AS "contentChangedAt",
           wp.created_at AS "createdAt", wp.voided_at AS "voidedAt",
           wp.void_reason::text AS "voidReason",
           wp.last_fetched_at AS "lastFetchedAt",
           l.id AS "linkId", l.fields::text[] AS "linkFields",
           l.expires_at AS "linkExpiresAt", l.revoked_at AS "linkRevokedAt",
           l.token_encrypted AS "linkTokenEncrypted"
      FROM wallet_passes wp
      JOIN emergency_card_links l ON l.id = wp.link_id
     WHERE wp.user_id = ${userId}
     ORDER BY wp.created_at DESC
     LIMIT 1`;
  const row = rows[0];
  if (!row) return null;
  const {
    linkId,
    linkFields,
    linkExpiresAt,
    linkRevokedAt,
    linkTokenEncrypted,
    ...pass
  } = row;
  return {
    ...pass,
    link: {
      id: linkId,
      fields: linkFields,
      expiresAt: linkExpiresAt,
      revokedAt: linkRevokedAt,
      tokenEncrypted: linkTokenEncrypted,
    },
  };
}

type LatestPassRow = Omit<WalletPassRow, "link"> & {
  linkId: string;
  linkFields: EmergencyCardField[];
  linkExpiresAt: Date | null;
  linkRevokedAt: Date | null;
  linkTokenEncrypted: string | null;
};

/** One pass by its id, withdrawn or not, or null. */
export function latestWalletPassById(
  walletPassId: string,
): Promise<WalletPassRow | null> {
  return prisma.walletPass.findUnique({
    where: { id: walletPassId },
    select: WALLET_PASS_SELECT,
  });
}

/** Whether the record has a pass whose link still works or waits to expire. */
export async function hasLiveWalletLink(userId: string): Promise<boolean> {
  const live = await prisma.emergencyCardLink.findFirst({
    where: { userId, revokedAt: null, purpose: "WALLET" },
    select: { id: true },
  });
  return live !== null;
}

/** Everything a pass's files are built from. */
export interface PassBuildInput {
  userId: string;
  fields: readonly EmergencyCardField[];
  locale: Locale;
  timezone: string;
  signer: WalletSignerIdentity;
  passTypeIdentifier: string;
  teamIdentifier: string;
  serialNumber: string;
  rawLinkToken: string;
  origin: string;
  contentChangedAt: Date;
  expiresAt: Date | null;
  voidedAt: Date | null;
  now: Date;
}

/**
 * When a pass stops carrying the record: the moment it was withdrawn, else
 * the moment its link expired. An expired link is as dead as a withdrawn one
 * (the `/e/` page refuses it), so the pass built from it is the withdrawn
 * version too, rather than a fresh copy of the record behind a link that no
 * longer opens. Null while the pass is live.
 */
export function walletPassEndedAt(
  input: Pick<PassBuildInput, "voidedAt" | "expiresAt" | "now">,
): Date | null {
  if (input.voidedAt) return input.voidedAt;
  const expires = input.expiresAt;
  return expires && expires.getTime() <= input.now.getTime() ? expires : null;
}

/**
 * The pass's files and their content hash. A withdrawn or expired pass reads
 * nothing from the record: its version carries no health data.
 */
export async function buildWalletPassFiles(
  input: PassBuildInput,
  nonce?: string,
): Promise<{ files: PassFiles; contentHash: string }> {
  const day = (d: Date) => moodDateKey(d, input.timezone);
  const endedAt = walletPassEndedAt(input);
  const view = await loadEmergencyCard(
    input.userId,
    day(input.now),
    endedAt ? [] : input.fields,
  );
  const content = buildPassContent({
    view,
    locale: input.locale,
    passTypeIdentifier: input.passTypeIdentifier,
    teamIdentifier: input.teamIdentifier,
    signer: input.signer,
    serialNumber: input.serialNumber,
    authenticationToken: walletAuthToken(
      input.rawLinkToken,
      input.serialNumber,
    ),
    origin: input.origin,
    linkUrl: cardLinkUrl(input.origin, input.rawLinkToken),
    asOfDay: day(input.contentChangedAt),
    expiresAt: input.expiresAt,
    expiresOnDay: input.expiresAt ? day(input.expiresAt) : null,
    voidedOnDay: endedAt ? day(endedAt) : null,
  });
  const files = buildPassFiles(content, nonce);
  return { files, contentHash: passContentHash(files) };
}

/** The signer identity drawn on a pass made with `signer`. */
export function signerIdentityFor(
  signer: "RELAY" | "LOCAL",
  passTypeIdentifier: string,
): WalletSignerIdentity {
  if (signer === "RELAY") return { kind: "relay" };
  const mode = walletSigningMode();
  return {
    kind: "local",
    organization:
      mode.kind === "local" &&
      mode.identity.passTypeIdentifier === passTypeIdentifier
        ? mode.identity.organization
        : passTypeIdentifier,
  };
}

export type SignedPass =
  | {
      ok: true;
      bytes: Uint8Array;
      state: WalletPassState;
      contentChangedAt: Date;
    }
  | { ok: false; reason: string; retryAfter: number };

export interface SyncedPassContent {
  files: PassFiles;
  contentChangedAt: Date;
  /** The content differed from the stored hash and the row moved on. */
  changed: boolean;
}

/**
 * Build the current files of `row` (unsigned) and compare them with the
 * stored `contentHash`. When the card changed since the last build, the hash
 * and `contentChangedAt` move on, so the "As of" date on the pass, the web
 * service's `Last-Modified` and its list of updated passes are true.
 */
export async function syncWalletPassContent(
  row: WalletPassRow,
  now: Date = new Date(),
): Promise<SyncedPassContent> {
  const raw = row.link.tokenEncrypted
    ? openWalletLinkToken(row.link.tokenEncrypted)
    : null;
  // The server's own key does not open its own column: a configuration
  // fault, not a state of the pass. Fail loudly rather than serve a pass
  // with another link.
  if (!raw) throw new Error("the wallet pass's link token does not open");

  const owner = await prisma.user.findUnique({
    where: { id: row.userId },
    select: { timezone: true },
  });
  const creator = await prisma.user.findUnique({
    where: { id: row.createdById },
    select: { locale: true },
  });
  const base: Omit<PassBuildInput, "contentChangedAt"> = {
    userId: row.userId,
    fields: row.link.fields,
    // The language of the person who made the pass, on every rebuild.
    locale: coerceLocale(creator?.locale),
    timezone: owner?.timezone || DEFAULT_TIMEZONE,
    signer: signerIdentityFor(row.signer, row.passTypeIdentifier),
    passTypeIdentifier: row.passTypeIdentifier,
    teamIdentifier: row.teamIdentifier,
    serialNumber: row.serialNumber,
    rawLinkToken: raw,
    origin: row.webServiceOrigin,
    expiresAt: row.link.expiresAt,
    voidedAt: walletPassVoidedAt(row),
    now,
  };

  let contentChangedAt = row.contentChangedAt;
  let built = await buildWalletPassFiles({ ...base, contentChangedAt });
  if (built.contentHash === row.contentHash) {
    return { files: built.files, contentChangedAt, changed: false };
  }
  contentChangedAt = now;
  built = await buildWalletPassFiles({ ...base, contentChangedAt });
  await prisma.walletPass.update({
    where: { id: row.id },
    data: { contentHash: built.contentHash, contentChangedAt },
  });
  return { files: built.files, contentChangedAt, changed: true };
}

/**
 * Bring the stored content state of one pass up to date, unsigned: what the
 * refresh job, the sweep and the void push do before they push. Null when
 * the pass is gone.
 */
export async function refreshWalletPass(
  walletPassId: string,
  now: Date = new Date(),
): Promise<{ row: WalletPassRow; changed: boolean } | null> {
  const row = await prisma.walletPass.findUnique({
    where: { id: walletPassId },
    select: WALLET_PASS_SELECT,
  });
  if (!row) return null;
  const synced = await syncWalletPassContent(row, now);
  return {
    row: { ...row, contentChangedAt: synced.contentChangedAt },
    changed: synced.changed,
  };
}

/** Sign files already built by `syncWalletPassContent`. */
export async function signSyncedPass(
  row: WalletPassRow,
  synced: SyncedPassContent,
  now: Date = new Date(),
): Promise<SignedPass> {
  const manifest = passManifest(synced.files);
  const signed = await signWalletManifest(manifest, {
    signer: row.signer,
    passTypeIdentifier: row.passTypeIdentifier,
    teamIdentifier: row.teamIdentifier,
  });
  if (!signed.ok) return signed;
  return {
    ok: true,
    bytes: assemblePkpass(synced.files, manifest, signed.signature),
    state: walletPassState(row, now),
    contentChangedAt: synced.contentChangedAt,
  };
}

/**
 * Build and sign the current version of `row`. Moves `contentHash` and
 * `contentChangedAt` on when the content changed since the last build.
 */
export async function buildSignedPass(
  row: WalletPassRow,
  now: Date = new Date(),
): Promise<SignedPass> {
  return signSyncedPass(row, await syncWalletPassContent(row, now), now);
}

export type { WalletPassVoidReason };

/**
 * Withdraw the record's live pass: its link stops answering and the pass is
 * stamped, in one transaction. Null when there is none to withdraw. The
 * printed card's link is not touched.
 */
export async function voidWalletPass(
  userId: string,
  reason: WalletPassVoidReason,
  now: Date = new Date(),
): Promise<{
  walletPassId: string;
  linkId: string;
  serialNumber: string;
  createdAt: Date;
} | null> {
  const voided = await prisma.$transaction(async (tx) => {
    const pass = await tx.walletPass.findFirst({
      where: { userId, voidedAt: null },
      orderBy: { createdAt: "desc" },
      select: { id: true, linkId: true, serialNumber: true, createdAt: true },
    });
    const live = await tx.emergencyCardLink.findMany({
      where: { userId, revokedAt: null, purpose: "WALLET" },
      select: { id: true },
    });
    if (!pass && live.length === 0) return null;
    await tx.emergencyCardLink.updateMany({
      where: { userId, revokedAt: null, purpose: "WALLET" },
      data: { revokedAt: now },
    });
    if (!pass) return null;
    await tx.walletPass.update({
      where: { id: pass.id },
      data: { voidedAt: now, voidReason: reason },
    });
    return {
      walletPassId: pass.id,
      linkId: pass.linkId,
      serialNumber: pass.serialNumber,
      createdAt: pass.createdAt,
    };
  });
  // The devices that hold the pass are told at once, so Wallet fetches the
  // withdrawn version; the void-push cron is the net under a lost send.
  if (voided) await enqueueWalletVoidPush();
  return voided;
}

/**
 * Withdraw one pass by its id (a guardian's pass whose MANAGE grant is gone)
 * and tell its devices. False when it was already withdrawn.
 */
export async function voidWalletPassById(
  walletPassId: string,
  reason: WalletPassVoidReason,
  now: Date = new Date(),
): Promise<boolean> {
  const count = await prisma.$transaction((tx) =>
    voidWalletPassesWhere(tx, { id: walletPassId }, reason, now),
  );
  if (count > 0) await enqueueWalletVoidPush();
  return count > 0;
}
