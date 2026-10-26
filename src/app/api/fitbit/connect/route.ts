import { apiHandler, requireAuth } from "@/lib/api-handler";
import { prisma } from "@/lib/db";
import { annotate, getEvent } from "@/lib/logging/context";
import { checkRateLimit } from "@/lib/rate-limit";
import { fitbitOAuth } from "@/lib/fitbit/oauth";
import { generatePkcePair } from "@/lib/integrations/oauth-kit/pkce";
import { getUserFitbitCredentials } from "@/lib/fitbit/credentials";
import {
  FITBIT_OAUTH_STATE_COOKIE,
  FITBIT_OAUTH_STATE_TTL_MS,
  mintFitbitOAuthStateNonce,
} from "@/lib/fitbit/oauth-state";
import { NextRequest, NextResponse } from "next/server";
import { relativeRedirect } from "@/lib/http/relative-redirect";
import { shouldEmitSecureCookie } from "@/lib/auth/secure-cookie";
import { isFitbitRetired } from "@/lib/fitbit/retirement";

/**
 * Redirect the user to the Fitbit OAuth consent page (classic
 * `www.fitbit.com/oauth2/authorize`, v1.20.0).
 *
 * Mirrors the WHOOP connect route: a fully-random base64url state nonce backed
 * by a 10-minute `FitbitOAuthState` ledger row carries the `(nonce → userId)`
 * mapping, so the user id never travels in the OAuth `state` param (which can
 * land in request logs / network captures). The httpOnly + Secure cookie
 * carries JUST the nonce; the callback resolves the user via the row's `userId`.
 *
 * v1.20.0 — the classic Fitbit Web API uses PKCE (S256). The route mints a
 * `code_verifier`/`code_challenge` pair, stashes the verifier on the ledger row
 * (server-side, never exposed to the browser), and sends the challenge to the
 * authorize endpoint. The callback reads the verifier back to present on the
 * token exchange.
 *
 * Rate-limited per user (10 calls / 60 s) so a logged-in session can't spam
 * ledger rows for the full 10-min TTL window. Both the rate-limit and
 * create-failure paths redirect (not JSON) because the entry point is a browser
 * navigation — a 429 envelope would surface as a blank page. The
 * no-credentials branch redirects too (v1.29.x), matching Withings/WHOOP.
 */
const CONNECT_RATE_LIMIT = 10;
const CONNECT_WINDOW_MS = 60_000;

export const GET = apiHandler(async (req: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "fitbit.connect" } });

  const rl = await checkRateLimit(
    `fitbit:connect:${user.id}`,
    CONNECT_RATE_LIMIT,
    CONNECT_WINDOW_MS,
  );
  if (!rl.allowed) {
    annotate({ action: { name: "fitbit.connect.rate_limited" } });
    return NextResponse.redirect(
      new URL(
        "/settings/integrations?fitbit=error&reason=rate_limited",
        req.url,
      ),
    );
  }

  // A grant issued now would never sync anything: Google has turned the Web
  // API off. The card explains the move to Google Health.
  if (isFitbitRetired()) {
    annotate({ action: { name: "fitbit.connect.retired" } });
    return relativeRedirect(
      "/settings/integrations?fitbit=error&reason=retired",
    );
  }

  const creds = await getUserFitbitCredentials(user.id);
  if (!creds) {
    annotate({ action: { name: "fitbit.connect.no_credentials" } });
    return relativeRedirect(
      "/settings/integrations?fitbit=error&reason=nocreds",
    );
  }

  const nonce = mintFitbitOAuthStateNonce();
  const pkce = generatePkcePair();
  try {
    await prisma.fitbitOAuthState.create({
      data: {
        nonce,
        userId: user.id,
        codeVerifier: pkce.verifier,
        expiresAt: new Date(Date.now() + FITBIT_OAUTH_STATE_TTL_MS),
      },
    });
  } catch (err) {
    getEvent()?.setError(err);
    annotate({ action: { name: "fitbit.connect.create_failed" } });
    return relativeRedirect(
      "/settings/integrations?fitbit=error&reason=connect",
    );
  }

  const url = fitbitOAuth.authorizationUrl(nonce, creds, pkce.challenge);

  const response = NextResponse.redirect(url);
  response.cookies.set(FITBIT_OAUTH_STATE_COOKIE, nonce, {
    httpOnly: true,
    secure: shouldEmitSecureCookie(),
    sameSite: "lax",
    maxAge: Math.floor(FITBIT_OAUTH_STATE_TTL_MS / 1000),
    path: "/",
  });

  return response;
});
