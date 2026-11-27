/**
 * Apple Wallet's pass web service on this instance (v1.50), the part every
 * route under `/api/wallet/apple/v1/` shares.
 *
 * Wallet speaks a fixed protocol to the `webServiceURL` inside the pass:
 * it registers a device for a pass's updates, asks which passes changed,
 * fetches a pass, unregisters, and sends its error log. The answers are
 * Apple's status codes with raw bodies, so the routes return plain
 * responses from inside `apiHandler`, as the PDF route does.
 *
 * Two credentials arrive, neither a session nor a Bearer token:
 *
 * - `Authorization: ApplePass <authenticationToken>` on everything about one
 *   pass. The token is not stored: it is recomputed from the pass's sealed
 *   link token and its serial number (`link-token.ts`) and compared in
 *   constant time. An unknown serial, a wrong token, a foreign Pass Type ID
 *   or the operator's external-access switch off all answer the same bare
 *   401.
 * - the `deviceLibraryIdentifier` in the path of the list of updated passes,
 *   which Apple's design leaves without any other authentication. It is
 *   looked up by its HMAC only, and the list names serial numbers and
 *   nothing else.
 *
 * Every call passes the per-address limit first, before any lookup, and both
 * credentials are scrubbed from logs (`redactSecrets`: the `ApplePass`
 * header form and the device segment of the path).
 */
import { NextResponse } from "next/server";
import { z } from "zod";

import { isApiGloballyEnabled } from "@/lib/app-settings";
import { hashToken } from "@/lib/auth/hmac";
import { encrypt } from "@/lib/crypto";
import { prisma } from "@/lib/db";
import { checkAuthSurfaceRateLimit } from "@/lib/rate-limit";

import { openWalletLinkToken, walletAuthTokenMatches } from "./link-token";
import { walletPassChangedAt } from "./push";
import { WALLET_PASS_SELECT, type WalletPassRow } from "./service";

/** Calls per source address and window, before any lookup. */
export const WALLET_WS_LIMIT = 300;
export const WALLET_WS_WINDOW_MS = 10 * 60 * 1000;
/** Devices registered per pass; the next one replaces the oldest. */
export const WALLET_MAX_REGISTRATIONS = 10;
export const WALLET_REGISTRATION_MAX_BYTES = 4 * 1024;
export const WALLET_LOG_MAX_BYTES = 16 * 1024;
/** What Wallet is told to wait when the pass cannot be signed right now. */
export const WALLET_WS_RETRY_S = 300;

const DEVICE_ID = /^[0-9A-Za-z]{1,128}$/;
const PASS_TYPE_ID = /^pass\.[A-Za-z0-9.-]{1,120}$/;
const SERIAL =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const AUTH = /^ApplePass ([0-9a-f]{64})$/;

export const walletRegistrationSchema = z
  .object({ pushToken: z.string().regex(/^[0-9a-fA-F]{64,200}$/) })
  .strict();

/** A bare status with no body, the way Wallet expects most answers. */
export function bare(status: number, headers?: HeadersInit): Response {
  return new NextResponse(null, { status, headers });
}

/** The per-address gate, or null when the call may go on. */
export async function walletWebServiceGate(
  request: Request,
): Promise<Response | null> {
  const rl = await checkAuthSurfaceRateLimit(
    request,
    "wallet-ws",
    WALLET_WS_LIMIT,
    WALLET_WS_WINDOW_MS,
  );
  if (rl.allowed) return null;
  const wait = Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000));
  return bare(429, { "Retry-After": String(wait) });
}

export const isDeviceId = (v: string) => DEVICE_ID.test(v);
export const isPassTypeId = (v: string) => PASS_TYPE_ID.test(v);
export const isSerial = (v: string) => SERIAL.test(v);

export type AuthenticatedPass = WalletPassRow & {
  /** The owner asked for the account to be deleted; the pass is withdrawn. */
  ownerPendingDeletion: boolean;
};

/**
 * The pass this `ApplePass` request is about, or null for every way it is
 * not one: one answer, the same 401, for all of them.
 */
export async function authenticateWalletPass(
  request: Request,
  passTypeId: string,
  serial: string,
): Promise<AuthenticatedPass | null> {
  const presented = AUTH.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!presented || !isPassTypeId(passTypeId) || !isSerial(serial)) {
    return null;
  }
  const [row, apiOn] = await Promise.all([
    prisma.walletPass.findUnique({
      where: { serialNumber: serial },
      select: {
        ...WALLET_PASS_SELECT,
        user: { select: { deletionRequestedAt: true } },
      },
    }),
    isApiGloballyEnabled(),
  ]);
  if (!row || !apiOn || row.passTypeIdentifier !== passTypeId) return null;
  const raw = row.link.tokenEncrypted
    ? openWalletLinkToken(row.link.tokenEncrypted)
    : null;
  if (!raw || !walletAuthTokenMatches(raw, serial, presented)) return null;
  const { user, ...pass } = row;
  return { ...pass, ownerPendingDeletion: user.deletionRequestedAt !== null };
}

/**
 * Register `deviceId` for the pass's updates: 201 when new, 200 when the
 * device was registered already (its push token is replaced).
 */
export async function registerWalletDevice(
  walletPassId: string,
  deviceId: string,
  pushToken: string,
): Promise<201 | 200> {
  const deviceLibraryIdHash = hashToken(deviceId);
  const sealed = encrypt(pushToken);
  const existing = await prisma.walletPassRegistration.findUnique({
    where: {
      walletPassId_deviceLibraryIdHash: { walletPassId, deviceLibraryIdHash },
    },
    select: { id: true },
  });
  if (existing) {
    await prisma.walletPassRegistration.update({
      where: { id: existing.id },
      data: { pushTokenEncrypted: sealed },
    });
    return 200;
  }
  try {
    await prisma.$transaction(async (tx) => {
      const others = await tx.walletPassRegistration.findMany({
        where: { walletPassId },
        orderBy: { updatedAt: "desc" },
        select: { id: true },
      });
      const surplus = others.slice(WALLET_MAX_REGISTRATIONS - 1);
      if (surplus.length > 0) {
        await tx.walletPassRegistration.deleteMany({
          where: { id: { in: surplus.map((r) => r.id) } },
        });
      }
      await tx.walletPassRegistration.create({
        data: {
          walletPassId,
          deviceLibraryIdHash,
          pushTokenEncrypted: sealed,
        },
      });
    });
    return 201;
  } catch (err) {
    // Two registrations of one device raced; the other one made the row.
    if ((err as { code?: string }).code === "P2002") return 200;
    throw err;
  }
}

export async function unregisterWalletDevice(
  walletPassId: string,
  deviceId: string,
): Promise<void> {
  await prisma.walletPassRegistration.deleteMany({
    where: { walletPassId, deviceLibraryIdHash: hashToken(deviceId) },
  });
}

/** `passesUpdatedSince`: our own Unix-millisecond tag, else "never". */
export function parseUpdatedSince(tag: string | null): Date | null {
  if (!tag || !/^\d{1,15}$/.test(tag)) return null;
  const ms = Number(tag);
  return Number.isSafeInteger(ms) ? new Date(ms) : null;
}

/**
 * The serial numbers of the passes `deviceId` registered under
 * `passTypeId` that changed after `since`, and the tag to send next time.
 * Null when there are none (Wallet expects 204 then).
 */
export async function updatedWalletSerials(
  deviceId: string,
  passTypeId: string,
  since: Date | null,
): Promise<{ serialNumbers: string[]; lastUpdated: string } | null> {
  if (!(await isApiGloballyEnabled())) return null;
  const regs = await prisma.walletPassRegistration.findMany({
    where: {
      deviceLibraryIdHash: hashToken(deviceId),
      walletPass: { passTypeIdentifier: passTypeId },
    },
    select: {
      walletPass: {
        select: {
          serialNumber: true,
          contentChangedAt: true,
          voidedAt: true,
          link: { select: { revokedAt: true, expiresAt: true } },
        },
      },
    },
  });
  let newest = 0;
  const serialNumbers: string[] = [];
  for (const { walletPass } of regs) {
    const changed = walletPassChangedAt(walletPass).getTime();
    if (since && changed <= since.getTime()) continue;
    serialNumbers.push(walletPass.serialNumber);
    newest = Math.max(newest, changed);
  }
  if (serialNumbers.length === 0) return null;
  return { serialNumbers: serialNumbers.sort(), lastUpdated: String(newest) };
}

/**
 * Whether a conditional fetch already holds this version: HTTP dates have
 * whole seconds, so the comparison is on seconds.
 */
export function notModifiedSince(
  ifModifiedSince: string | null,
  contentChangedAt: Date,
): boolean {
  if (!ifModifiedSince) return false;
  const held = Date.parse(ifModifiedSince);
  if (!Number.isFinite(held)) return false;
  return (
    Math.floor(contentChangedAt.getTime() / 1000) <= Math.floor(held / 1000)
  );
}
