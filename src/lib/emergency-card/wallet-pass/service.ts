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
    lastFetchedAt: row.lastFetchedAt?.toISOString() ?? null,
    downloadPath: WALLET_DOWNLOAD_PATH,
  };
}

/** The record's newest pass, withdrawn or not, or null. */
export function latestWalletPass(
  userId: string,
): Promise<WalletPassRow | null> {
  return prisma.walletPass.findFirst({
    where: { userId },
    orderBy: { createdAt: "desc" },
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
 * The pass's files and their content hash. A withdrawn pass reads nothing
 * from the record: its version carries no health data.
 */
export async function buildWalletPassFiles(
  input: PassBuildInput,
  nonce?: string,
): Promise<{ files: PassFiles; contentHash: string }> {
  const day = (d: Date) => moodDateKey(d, input.timezone);
  const voided = input.voidedAt !== null;
  const view = await loadEmergencyCard(
    input.userId,
    day(input.now),
    voided ? [] : input.fields,
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
    voidedOnDay: input.voidedAt ? day(input.voidedAt) : null,
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

/**
 * Build and sign the current version of `row`. Moves `contentHash` and
 * `contentChangedAt` on when the content changed since the last build.
 */
export async function buildSignedPass(
  row: WalletPassRow,
  now: Date = new Date(),
): Promise<SignedPass> {
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
  if (built.contentHash !== row.contentHash) {
    contentChangedAt = now;
    built = await buildWalletPassFiles({ ...base, contentChangedAt });
    await prisma.walletPass.update({
      where: { id: row.id },
      data: { contentHash: built.contentHash, contentChangedAt },
    });
  }

  const manifest = passManifest(built.files);
  const signed = await signWalletManifest(manifest, {
    signer: row.signer,
    passTypeIdentifier: row.passTypeIdentifier,
    teamIdentifier: row.teamIdentifier,
  });
  if (!signed.ok) return signed;
  return {
    ok: true,
    bytes: assemblePkpass(built.files, manifest, signed.signature),
    state: walletPassState(row, now),
    contentChangedAt,
  };
}

export type WalletPassVoidReason =
  | "OWNER"
  | "CREDENTIAL_RESET"
  | "HANDOVER"
  | "GUARDIAN_LOST"
  | "ACCOUNT_DELETION";

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
  return prisma.$transaction(async (tx) => {
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
}
