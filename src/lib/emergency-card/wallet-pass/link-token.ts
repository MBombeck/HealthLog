/**
 * The credentials of an Apple Wallet pass (v1.50).
 *
 * A pass carries its own `hlm_` link in its QR code. Unlike the printed
 * card's link, whose raw token is shown once and never stored, the pass's
 * raw token is kept sealed under the instance key (`encrypt()`, AES-256-GCM),
 * because every update of the pass draws the QR code again. That is the one
 * emergency-card credential stored recoverably; the database holds it to
 * WALLET links only (a CHECK in migration 0564), and backups never carry it.
 *
 * The pass's `authenticationToken` (the secret Apple Wallet sends back to the
 * web service) is not stored at all. It is derived from the raw link token
 * and the serial number with HMAC-SHA256, one way: a device that holds the
 * pass cannot recover the link from it, and a new link means a new token.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import { decrypt, encrypt } from "@/lib/crypto";

import { parseCardTokenSegment } from "../token";

const AUTH_TOKEN_CONTEXT = "hl-wallet-auth-v1\n";

/** Seal a WALLET link's raw token for `EmergencyCardLink.tokenEncrypted`. */
export function sealWalletLinkToken(raw: string): string {
  if (!parseCardTokenSegment(raw)) {
    throw new Error("not an emergency card token");
  }
  return encrypt(raw);
}

/**
 * The raw token of a sealed WALLET link, or null when it does not open or
 * does not hold a card token. Decryption fails closed (`decrypt` throws on a
 * missing or unknown key); this turns that into "no token", which every
 * caller answers like an unknown pass.
 */
export function openWalletLinkToken(sealed: string): string | null {
  try {
    return parseCardTokenSegment(decrypt(sealed));
  } catch {
    return null;
  }
}

/** The pass's `authenticationToken`: 64 hex characters. */
export function walletAuthToken(rawLinkToken: string, serial: string): string {
  return createHmac("sha256", rawLinkToken)
    .update(AUTH_TOKEN_CONTEXT + serial)
    .digest("hex");
}

/** Whether a presented `ApplePass` token belongs to this link and serial. */
export function walletAuthTokenMatches(
  rawLinkToken: string,
  serial: string,
  presented: string,
): boolean {
  const expected = Buffer.from(walletAuthToken(rawLinkToken, serial));
  const given = Buffer.from(presented);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
