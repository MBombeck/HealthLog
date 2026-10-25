import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { apiHandler } from "@/lib/api-handler";
import { annotate, getEvent } from "@/lib/logging/context";
import { checkAuthSurfaceRateLimit } from "@/lib/rate-limit";
import {
  validateSessionFromCookieValue,
  SESSION_COOKIE_NAME,
} from "@/lib/auth/session";
import {
  discoverOidcMetadata,
  exchangeCodeForTokens,
  fetchUserinfoEmail,
  getOidcConfig,
  getOidcRedirectUri,
  oidcAppUrl,
  verifyIdToken,
} from "@/lib/auth/oidc";
import {
  OIDC_MFA_COOKIE,
  OIDC_MFA_COOKIE_PATH,
  OIDC_MFA_TTL_MS,
  OIDC_STATE_COOKIE,
  OIDC_STATE_COOKIE_PATH,
} from "@/lib/auth/oidc-cookie";
import { shouldEmitSecureCookie } from "@/lib/auth/secure-cookie";
import { buildNativeCallbackUrl } from "@/lib/auth/oidc-native-handoff";
import { setPendingLinkCookie } from "@/lib/auth/oidc-pending-link";
import {
  idpErrorCode,
  readStoredOidcState,
} from "@/lib/auth/oidc-callback/state";
import { resolveOidcAccount } from "@/lib/auth/oidc-callback/resolve-account";
import {
  mintOidcNativeHandoff,
  openOidcSession,
  startOidcSecondFactor,
} from "@/lib/auth/oidc-callback/complete-sign-in";
import {
  CLAIM_COOKIE,
  CLAIM_ERROR_PATH,
  claimMatchesBinding,
  clearClaimCookie,
  readClaimCookie,
} from "@/lib/managed-profiles/claim-cookie";
import {
  completeSsoClaim,
  SSO_CLAIM_LANDING,
} from "@/lib/managed-profiles/claim-sso";
import { pendingDeletionOf } from "@/lib/account-deletion/pending";
import { isHandoverUsable } from "@/lib/managed-profiles/handover";

const LOGIN_ERROR_URL = "/auth/login";

function errorRedirect(reason: string): NextResponse {
  const response = NextResponse.redirect(
    oidcAppUrl(`${LOGIN_ERROR_URL}?error=${reason}`),
  );
  deleteStateCookie(response);
  return response;
}

/**
 * The web sign-in page, with the single-use second-factor ticket parked in a
 * short-lived cookie its script reads (`OIDC_MFA_COOKIE`).
 */
function secondFactorRedirect(
  next: string,
  secondFactor: { ticket: string; methods: readonly string[] },
): NextResponse {
  const loginUrl = oidcAppUrl(LOGIN_ERROR_URL);
  if (next !== "/") {
    loginUrl.searchParams.set("next", next);
  }
  const response = NextResponse.redirect(loginUrl);
  deleteStateCookie(response);
  response.cookies.set(
    OIDC_MFA_COOKIE,
    JSON.stringify({
      ticket: secondFactor.ticket,
      methods: secondFactor.methods,
    }),
    {
      // Not httpOnly by design — see the constant's doc comment.
      httpOnly: false,
      secure: shouldEmitSecureCookie(),
      sameSite: "lax",
      maxAge: Math.floor(OIDC_MFA_TTL_MS / 1000),
      path: OIDC_MFA_COOKIE_PATH,
    },
  );
  return response;
}

/**
 * The web sign-in page for an account pending deletion, with the date it is
 * erased, so the page can say until when an admin can undo it.
 */
function deletionPendingRedirect(purgeAt: Date | null): NextResponse {
  const url = oidcAppUrl(LOGIN_ERROR_URL);
  url.searchParams.set("error", "account_deletion_pending");
  if (purgeAt) url.searchParams.set("purgeAt", purgeAt.toISOString());
  const response = NextResponse.redirect(url);
  deleteStateCookie(response);
  return response;
}

/**
 * The state cookie is set with `path: "/api/auth/oidc"`; the delete must
 * repeat that path (RFC 6265 keys cookies by name+domain+path — a bare
 * delete would target `/` and never match, leaving the single-use blob
 * alive for the rest of its TTL).
 */
function deleteStateCookie(response: NextResponse): void {
  response.cookies.delete({
    name: OIDC_STATE_COOKIE,
    path: OIDC_STATE_COOKIE_PATH,
  });
}

/**
 * OIDC callback. Must work with NO existing session — this route
 * authenticates the user in the first place, unlike the per-account
 * integration callbacks (Withings/Polar/etc.) which all require
 * `requireAuth()`. Every failure branch redirects to `/auth/login?error=...`
 * (never JSON — this is a top-level browser navigation) and deletes the
 * single-use state cookie, mirroring `src/app/api/withings/callback/route.ts`.
 *
 * The state blob, the account resolution and the three endings (second
 * factor, native handoff, session) live in `src/lib/auth/oidc-callback/`.
 */
export const GET = apiHandler(async (req: NextRequest) => {
  annotate({ action: { name: "auth.oidc.callback" } });

  // Decrypt the single-use state blob FIRST. The `native` flag lives inside the
  // AES-256-GCM payload (tamper-authenticated), so decrypting it up front lets
  // every post-decrypt error branch redirect to the custom scheme instead of
  // the web login page — the app parses `?error=<reason>` and never lands on a
  // dead web page. A missing/undecryptable blob leaves `stored` null (isNative
  // false) and those branches fall back to the web redirect by construction.
  const stored = readStoredOidcState(req.cookies.get(OIDC_STATE_COOKIE)?.value);
  const isNative = stored?.native === true;
  const isClaim = stored?.intent === "claim";

  // Native-aware error redirect: the custom scheme for a decrypted native flow,
  // the web login page otherwise. Deletes the single-use state cookie either
  // way. An error redirect carries no code, ticket, or session, so routing it
  // to the scheme leaks nothing (spec §1).
  // v1.43 (#959) — a refused claim returns to the claim page, never the
  // sign-in page, and takes the claim cookie with it: the person starts again
  // from the link, which is still theirs to use if the refusal left it open.
  // Browser-only, like `errorRedirect`: a claim is never native.
  const claimRedirect = (reason: string): NextResponse => {
    const response = NextResponse.redirect(
      oidcAppUrl(`${CLAIM_ERROR_PATH}?error=${reason}`),
    );
    deleteStateCookie(response);
    clearClaimCookie(response);
    return response;
  };

  const failRedirect = (reason: string): NextResponse => {
    if (isClaim) return claimRedirect(reason);
    if (isNative) {
      const response = NextResponse.redirect(
        buildNativeCallbackUrl({ error: reason }),
      );
      deleteStateCookie(response);
      return response;
    }
    return errorRedirect(reason);
  };

  const config = getOidcConfig();
  if (!config) return failRedirect("oidc_disabled");

  const rl = await checkAuthSurfaceRateLimit(
    req,
    "auth:oidc:callback",
    20,
    15 * 60 * 1000,
  );
  const ip = rl.ip ?? "unknown";
  if (!rl.allowed) return failRedirect("oidc_rate_limited");

  const { searchParams } = req.nextUrl;
  const idpError = searchParams.get("error");
  if (idpError) {
    annotate({
      meta: {
        reason: "idp_denied",
        idpError: idpErrorCode(idpError),
      },
    });
    return failRedirect("oidc_denied");
  }

  const code = searchParams.get("code");
  const state = searchParams.get("state");
  // Broken round-trip / missing-or-unreadable state blob / CSRF mismatch all
  // resolve to the web `oidc_state` fallback: the flow is fundamentally broken
  // and there is nothing safe to hand the app (spec §1 web-fallback).
  if (!code || !state) {
    return isClaim ? claimRedirect("oidc_state") : errorRedirect("oidc_state");
  }

  if (!stored) {
    // Defence-in-depth idempotency for a duplicated callback. The single-use
    // state cookie is set with `path: "/api/auth/oidc"` and DELETED by the
    // first callback the moment it succeeds. A second callback for the same
    // sign-in (a client/proxy retry, a double navigation, or the
    // service-worker double-request this release also fixes) therefore arrives
    // with the state cookie already gone — `stored` is null — and, because the
    // first callback set the session, it carries a live session cookie.
    // Redeeming the now-consumed authorization code again fails at the IdP and
    // surfaces `?error=oidc_failed` on a sign-in that actually succeeded. So
    // when a VALIDATED session is present, treat this as a duplicate of a
    // completed login and send the user into the app instead of erroring.
    //
    // Fail-closed is preserved for the real attack case: the code is NEVER
    // exchanged on this branch, and the session is resolved against the
    // database + its expiry (not merely "a cookie is present"). A forged,
    // replayed, or expired state from a caller with no valid session gets the
    // unchanged `oidc_state` error; a caller who already holds their own valid
    // session gains nothing here but a redirect to a page they could already
    // reach — no code redemption, no session mint, no identity change.
    const existingSession = await validateSessionFromCookieValue(
      req.cookies.get(SESSION_COOKIE_NAME)?.value,
    );
    if (existingSession) {
      annotate({ meta: { reason: "duplicate_callback_authenticated" } });
      const response = NextResponse.redirect(oidcAppUrl("/"));
      // The state cookie is already consumed; delete defensively so a stray
      // blob can never outlive this response.
      deleteStateCookie(response);
      return response;
    }
    return errorRedirect("oidc_state");
  }

  // CSRF check — timing-safe, byte-for-byte, mirroring the Withings callback.
  if (
    state.length !== stored.state.length ||
    !timingSafeEqual(Buffer.from(state), Buffer.from(stored.state))
  ) {
    annotate({ meta: { reason: "csrf" } });
    return isClaim ? claimRedirect("oidc_state") : errorRedirect("oidc_state");
  }

  // v1.43 (#959) — a claim is never finished over a live session (the claim
  // routes' rule: a Guardian finishing their own link would otherwise be
  // signed out of their account and into the person's), and is admitted only
  // with its own sealed cookie, still bound to this sign-in, for a link that
  // is still usable. All of it before the code is redeemed, so a refused claim
  // spends nothing at the provider.
  const pendingClaim = isClaim
    ? readClaimCookie(req.cookies.get(CLAIM_COOKIE)?.value)
    : null;
  if (isClaim) {
    const liveSession = await validateSessionFromCookieValue(
      req.cookies.get(SESSION_COOKIE_NAME)?.value,
    );
    if (liveSession) {
      annotate({ meta: { reason: "claim_signed_in" } });
      return failRedirect("claim_signed_in");
    }
    if (
      !pendingClaim ||
      !claimMatchesBinding(pendingClaim, stored.claimBinding as string) ||
      !(await isHandoverUsable(pendingClaim.handoverId))
    ) {
      annotate({ meta: { reason: "claim_expired" } });
      return failRedirect("claim_expired");
    }
  }

  try {
    const metadata = await discoverOidcMetadata(config);
    const redirectUri = getOidcRedirectUri();

    const tokens = await exchangeCodeForTokens({
      metadata,
      config,
      code,
      codeVerifier: stored.codeVerifier,
      redirectUri,
    });
    if (!tokens.id_token) return failRedirect("oidc_failed");

    const identity = await verifyIdToken({
      metadata,
      config,
      idToken: tokens.id_token,
      nonce: stored.nonce,
    });

    let email = identity.email;
    let emailVerified = identity.emailVerified;
    if (!email && tokens.access_token) {
      const userinfo = await fetchUserinfoEmail({
        metadata,
        accessToken: tokens.access_token,
      });
      email = userinfo.email;
      emailVerified = userinfo.emailVerified;
    }

    // v1.43 (#959) — the claim. The provider has authenticated somebody; bind
    // that subject to the profile the cookie names, or refuse. Never falls
    // through to the sign-in below: a refused claim signs nobody in, and
    // provisions and links nothing.
    if (pendingClaim) {
      const outcome = await completeSsoClaim({
        handoverId: pendingClaim.handoverId,
        username: pendingClaim.username,
        issuer: metadata.issuer,
        sub: identity.sub,
        email,
        emailVerified,
        ipAddress: ip,
        userAgent: req.headers.get("user-agent"),
      });
      if (!outcome.ok) return failRedirect(outcome.reason);
      const response = NextResponse.redirect(oidcAppUrl(SSO_CLAIM_LANDING));
      deleteStateCookie(response);
      clearClaimCookie(response);
      return response;
    }

    const account = await resolveOidcAccount({
      issuer: metadata.issuer,
      sub: identity.sub,
      email,
      emailVerified,
      ip,
    });
    if (account.kind === "refused") return failRedirect(account.reason);
    if (account.kind === "linkPending") {
      if (isNative) {
        // The native sign-in sheet cannot run the confirmation; the person
        // signs in on the web once, after which the app's SSO works.
        return failRedirect("oidc_link_required");
      }
      const response = errorRedirect("oidc_link_required");
      setPendingLinkCookie(response, {
        userId: account.userId,
        issuer: metadata.issuer,
        sub: identity.sub,
      });
      return response;
    }
    const user = account.user;

    // An account pending deletion is locked. The identity provider proved
    // the caller is this account, so the sign-in page may name the date.
    const pendingDeletion = await pendingDeletionOf(user.id);
    if (pendingDeletion) {
      if (isNative || isClaim) return failRedirect("account_deletion_pending");
      return deletionPendingRedirect(pendingDeletion.purgeAt);
    }

    const secondFactor = await startOidcSecondFactor(user, ip, isNative);
    if (secondFactor) {
      // Native: hand the app the SAME single-use ticket via the custom scheme.
      // No `OIDC_MFA_COOKIE` (it exists only to ferry the ticket to the web
      // login page's script) and no session — the app completes at the
      // existing native-capable `/api/auth/mfa/verify{,/webauthn}` endpoints,
      // which end in `finishLogin` and return the native bundle directly. The
      // ticket alone is inert: single-use, hashed at rest, 5-minute TTL,
      // 5-attempt cap, factor-gated.
      if (isNative) {
        const response = NextResponse.redirect(
          buildNativeCallbackUrl({
            mfa_ticket: secondFactor.ticket,
            methods: secondFactor.methods.join(","),
          }),
        );
        deleteStateCookie(response);
        return response;
      }

      return secondFactorRedirect(stored.next, secondFactor);
    }

    const ua = req.headers.get("user-agent");

    if (isNative) {
      const handoffCode = await mintOidcNativeHandoff({
        userId: user.id,
        // Guaranteed present by the state reader when `native === true`.
        appCodeChallenge: stored.appCodeChallenge as string,
        ip,
        userAgent: ua,
      });
      const response = NextResponse.redirect(
        buildNativeCallbackUrl({ code: handoffCode }),
      );
      deleteStateCookie(response);
      return response;
    }

    await openOidcSession(user, ip, ua);

    const response = NextResponse.redirect(oidcAppUrl(stored.next));
    deleteStateCookie(response);
    return response;
  } catch (err) {
    getEvent()?.setError(err);
    annotate({ meta: { reason: "exchange_or_verify_failed" } });
    return failRedirect("oidc_failed");
  }
});
