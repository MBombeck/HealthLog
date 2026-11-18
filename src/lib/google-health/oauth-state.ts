/**
 * Shared constants + mint helper for the Google Health OAuth state nonce ledger.
 * Mirrors `src/lib/whoop/oauth-state.ts`.
 *
 * The nonce is random + opaque; a short-lived `GoogleHealthOAuthState` row
 * carries the `(nonce → userId)` mapping (plus the PKCE code verifier) so the
 * user id and the verifier never leak into request logs or network captures via
 * the OAuth `state` param. The connect route, the callback route, and the
 * cleanup cron all read these constants so the contract has one source of truth
 * and the unit tests can pin it without importing either route file.
 */
import { randomBytes } from "node:crypto";

/**
 * Cookie name carrying the in-flight state nonce. httpOnly + Secure +
 * sameSite:lax at the connect route (mirrors the WHOOP cookie shape).
 */
export const GOOGLE_HEALTH_OAUTH_STATE_COOKIE = "google_health_state" as const;

/**
 * 10-minute TTL on the state row. Matches the cookie `maxAge`. Long enough to
 * cover a user approving the Google consent prompt; short enough that an
 * abandoned handshake doesn't strand a row for hours.
 */
export const GOOGLE_HEALTH_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/**
 * Mint a fresh state nonce. 16 random bytes → 22 base64url chars without
 * padding — 128 bits of entropy, aligned with the OAuth 2.0 §10.10 "at least
 * 128 bits" recommendation.
 */
export function mintGoogleHealthOAuthStateNonce(): string {
  return randomBytes(16).toString("base64url");
}
