/**
 * Confirming it is you through the identity provider.
 *
 * An account created by single sign-on holds no password, passkey or second
 * factor, so the recent-proof gate (token minting, exports, share links, the
 * admin data actions) had nothing to ask it for. This is the proof such an
 * account can give: the browser goes back to the provider with
 * `prompt=login` and `max_age=0`, and the callback counts the round trip only
 * when the ID token says the provider authenticated the person inside the
 * gate's own window and names the identity linked to the signed-in account.
 *
 * It records the proof exactly as a password re-proof does, `Session.reproofAt`
 * and nothing else, so it never stands in for a second factor. It creates no
 * session and switches none: the callback stamps the session row the start
 * bound into the sealed state, and only while the browser still carries it.
 *
 * Start: `GET /api/auth/oidc/reproof?next=<path>`. Finish: the shared
 * `GET /api/auth/oidc/callback` with `intent: "reproof"` in the state blob.
 */
import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import { annotate } from "@/lib/logging/context";
import { oidcAppUrl, type OidcIdentity } from "@/lib/auth/oidc";
import {
  RECENT_PROOF_MAX_AGE_MS,
  recordReproofFailure,
  refundReproof,
} from "@/lib/auth/existing-factor-proof";

/** The query parameter the browser comes back with, and its two values. */
export const OIDC_REPROOF_RESULT_PARAM = "reproof";
export type OidcReproofResult = "done" | "failed";

/** The stage name the shared re-proof bucket and the audit rows carry. */
export const OIDC_REPROOF_STAGE = "oidc_reproof";

/**
 * How far in the future `auth_time` may sit and still count: the clock
 * tolerance `verifyIdToken` already grants `iat` and `exp`, for an identity
 * provider on another box whose clock runs a little ahead.
 */
const AUTH_TIME_FUTURE_TOLERANCE_MS = 60_000;

/**
 * Did the provider authenticate the person inside the gate's window (the five
 * minutes every recent-proof surface uses)? A token
 * without `auth_time` is refused: with `max_age` in the request the provider
 * owes the claim (OpenID Connect Core 2), and without it nothing says the
 * person signed in now rather than an hour ago.
 */
export function isFreshAuthTime(
  authTime: number | null,
  nowMs: number,
  maxAgeMs: number = RECENT_PROOF_MAX_AGE_MS,
): boolean {
  if (authTime === null) return false;
  const at = authTime * 1000;
  return nowMs - at <= maxAgeMs && at - nowMs <= AUTH_TIME_FUTURE_TOLERANCE_MS;
}

/**
 * Is the identity the provider named the one linked to this account? Both
 * halves, compared exactly: the subject is only unique per issuer.
 */
export function isLinkedIdentity(
  account: { oidcIssuer: string | null; oidcSub: string | null },
  issuer: string,
  sub: string,
): boolean {
  return (
    account.oidcIssuer !== null &&
    account.oidcSub !== null &&
    account.oidcIssuer === issuer &&
    account.oidcSub === sub
  );
}

/**
 * Does the browser still carry the session the round trip was started from?
 * Checked before the code is redeemed, so a mismatch spends nothing at the
 * provider.
 */
export function isReproofSession(
  bound: { reproofUserId?: string; reproofSessionId?: string },
  live: { session: { id: string }; user: { id: string } } | null,
): boolean {
  return (
    live !== null &&
    typeof bound.reproofSessionId === "string" &&
    typeof bound.reproofUserId === "string" &&
    live.session.id === bound.reproofSessionId &&
    live.user.id === bound.reproofUserId
  );
}

/** Where the browser lands: the page it left, with the outcome attached. */
export function reproofReturnUrl(next: string, result: OidcReproofResult): URL {
  const url = oidcAppUrl(next);
  url.searchParams.set(OIDC_REPROOF_RESULT_PARAM, result);
  return url;
}

export type OidcReproofOutcome =
  { ok: true } | { ok: false; reason: "identity_mismatch" | "stale_auth_time" };

/**
 * Check the verified ID token against the account and stamp the session.
 * Every refusal is audited like a failed password re-proof; a success gives
 * back the attempt the start charged to the shared bucket.
 */
export async function recordOidcReproof(args: {
  userId: string;
  sessionId: string;
  issuer: string;
  identity: Pick<OidcIdentity, "sub" | "authTime">;
  ipAddress: string | null;
  nowMs?: number;
}): Promise<OidcReproofOutcome> {
  const { userId, sessionId, issuer, identity, ipAddress } = args;
  const nowMs = args.nowMs ?? Date.now();

  const account = await prisma.user.findUnique({
    where: { id: userId },
    select: { oidcIssuer: true, oidcSub: true },
  });
  let refusal: "identity_mismatch" | "stale_auth_time" | null = null;
  if (!account || !isLinkedIdentity(account, issuer, identity.sub)) {
    refusal = "identity_mismatch";
  } else if (!isFreshAuthTime(identity.authTime, nowMs)) {
    refusal = "stale_auth_time";
  }
  if (refusal) {
    await recordReproofFailure(
      userId,
      ipAddress,
      OIDC_REPROOF_STAGE,
      "oidc",
      refusal,
    );
    return { ok: false, reason: refusal };
  }

  // The proof is as old as the authentication, not the callback: the gate's
  // window then runs from the moment the person signed in at the provider,
  // so a token near the end of its window buys no extra minutes. A provider
  // clock a little ahead is clamped to now, never stamped into the future.
  // (A token without `auth_time` was refused above.)
  const authenticatedAtMs =
    identity.authTime === null
      ? nowMs
      : Math.min(identity.authTime * 1000, nowMs);
  await prisma.session.update({
    where: { id: sessionId },
    data: { reproofAt: new Date(authenticatedAtMs) },
  });
  await refundReproof(userId);
  await auditLog("auth.reproof.succeeded", {
    userId,
    ipAddress,
    details: { method: "oidc" },
  });
  annotate({
    action: { name: "auth.reproof.succeeded" },
    meta: { method: "oidc" },
  });
  return { ok: true };
}
