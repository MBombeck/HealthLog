/**
 * Pairing an Android device running HealthLog Sync.
 *
 * The web mints a one-time code (`POST /api/health-connect/pairing`) and
 * shows it as a QR code; the app exchanges it once (`POST
 * /api/health-connect/pair`) for a token with the single scope
 * `health-connect:write`, bound to a `Device` row. There is no refresh token:
 * the native refresh path mints `["*"]`, which this credential must never
 * reach. Instead the token lives a year and every accepted batch moves its end
 * a year out once less than a month is left, so a phone in use never expires
 * and a lost one stops working within a year.
 */
import { randomBytes } from "node:crypto";

import type { Prisma, PrismaClient } from "@/generated/prisma/client";

/** A code is valid this long after it was minted. */
export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;

/** Days a paired device's token lives, from the pair or the last extension. */
export const HC_TOKEN_LIFETIME_DAYS = 365;

/** An accepted batch extends the token once fewer days than this are left. */
export const HC_TOKEN_EXTEND_BELOW_DAYS = 30;

/** The `Device.platform` and `bundleId` of a paired Android device. */
export const HC_DEVICE_PLATFORM = "android";
export const HC_DEVICE_BUNDLE_ID = "dev.healthlog.sync";

const DAY_MS = 86_400_000;

/** A fresh `hcp_<32 hex>` code. Shown once, stored as its hash. */
export function generatePairingCode(): string {
  return `hcp_${randomBytes(16).toString("hex")}`;
}

/**
 * The instance origin the app talks to: the operator-configured `APP_URL`
 * / `NEXT_PUBLIC_APP_URL` over the request's (which may be an internal
 * hostname behind the proxy), as the invite link resolves it.
 */
export function pairingServerOrigin(requestUrl: string): string {
  const candidates = [
    process.env.APP_URL,
    process.env.NEXT_PUBLIC_APP_URL,
    requestUrl,
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    try {
      return new URL(candidate).origin;
    } catch {
      // try the next candidate
    }
  }
  return "http://localhost:3000";
}

/** The deep link the QR code carries. */
export function pairingLink(origin: string, code: string): string {
  const params = new URLSearchParams({ server: origin, code });
  return `healthlog-sync://pair?${params.toString()}`;
}

/** The `Device.token` an install pairs under; namespaced away from iOS. */
export function hcDeviceToken(installId: string): string {
  return `android:${installId}`;
}

/**
 * Move the token's end a year out when less than a month is left. A
 * conditional update, so two batches racing extend it once and a revoked
 * token is never brought back.
 */
export async function extendTokenOnUse(
  prisma: Pick<PrismaClient, "apiToken">,
  tokenId: string,
  now: Date = new Date(),
): Promise<Date | null> {
  const threshold = new Date(
    now.getTime() + HC_TOKEN_EXTEND_BELOW_DAYS * DAY_MS,
  );
  const next = new Date(now.getTime() + HC_TOKEN_LIFETIME_DAYS * DAY_MS);
  const { count } = await prisma.apiToken.updateMany({
    where: {
      id: tokenId,
      revoked: false,
      expiresAt: { lt: threshold, gt: now },
    },
    data: { expiresAt: next },
  });
  return count > 0 ? next : null;
}

/**
 * Revoke the token a device was paired with. Called when the device is
 * deleted and when the same install pairs again.
 */
export async function revokePairedToken(
  db: Pick<Prisma.TransactionClient, "apiToken">,
  apiTokenId: string | null,
): Promise<void> {
  if (!apiTokenId) return;
  await db.apiToken.updateMany({
    where: { id: apiTokenId, revoked: false },
    data: { revoked: true },
  });
}
