/**
 * v1.4.47 W6 — shared constants + mint helper for the Withings OAuth
 * state nonce ledger.
 *
 * The legacy implementation (v1.4.42-) built the state as
 * `${user.id}:${random16}` and persisted it on both the URL state
 * param and the `withings_state` cookie. The cookie is httpOnly +
 * Secure + sameSite:lax so XSS exfiltration is closed, but the user
 * id still leaks into request logs / network captures (the v1.4.43
 * security audit L-1 finding). The new shape decouples the two: the
 * nonce is random + opaque, and a short-lived `WithingsOAuthState`
 * row carries the `(nonce → userId)` mapping.
 *
 * The helpers live on their own module so the connect route, the
 * callback route, and the cleanup cron all read the same source of
 * truth — and the unit tests can pin the contract without importing
 * either route file.
 */
import { randomBytes } from "node:crypto";

/**
 * Cookie name carrying the in-flight state nonce. Same string as the
 * legacy `withings_state` cookie so a deploy mid-flight doesn't
 * orphan a user's open Withings tab — the cookie shape is what
 * changed (nonce-only instead of `${userId}:${nonce}`), not the
 * cookie name.
 */
export const WITHINGS_OAUTH_STATE_COOKIE = "withings_state" as const;

/**
 * 10-minute TTL on the state row. Matches the cookie `maxAge`. Long
 * enough to cover a user typing their Withings credentials and
 * approving the consent prompt; short enough that an abandoned
 * handshake doesn't leave a row stranded for the daily cleanup sweep
 * to pick up hours later.
 */
export const WITHINGS_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/**
 * Mint a fresh state nonce. 16 random bytes → 22 base64url chars
 * (Node's `randomBytes(16).toString("base64url")` returns exactly 22
 * characters without padding for any 16-byte input). 128 bits of
 * entropy — well past the CSRF threshold and aligned with the OAuth
 * 2.0 §10.10 recommendation of "at least 128 bits".
 */
export function mintWithingsOAuthStateNonce(): string {
  return randomBytes(16).toString("base64url");
}
