import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { annotate, getEvent } from "@/lib/logging/context";
import { checkRateLimit } from "@/lib/rate-limit";
import { getAuthorizationUrl } from "@/lib/withings/client";
import { getUserWithingsCredentials } from "@/lib/withings/credentials";
import {
  WITHINGS_OAUTH_STATE_COOKIE,
  WITHINGS_OAUTH_STATE_TTL_MS,
  mintWithingsOAuthStateNonce,
} from "@/lib/withings/oauth-state";
import { NextRequest, NextResponse } from "next/server";

/**
 * Redirects the user to Withings OAuth authorization page.
 *
 * v1.4.47 W6 — state is now a fully-random 22-character base64url
 * nonce backed by a 10-minute `WithingsOAuthState` row, rather than
 * the legacy `${user.id}:${random16}` shape. The cookie carries JUST
 * the nonce (no user id), the OAuth state URL param carries JUST the
 * nonce, and the callback resolves the user via the row's `userId`
 * column. Closes the v1.4.43 security audit L-1 finding where the
 * user id was recoverable from log entries / network captures.
 *
 * v1.4.48 L5 + L14 — endpoint is now rate-limited per-user (10 calls
 * per 60 s) so a logged-in user with valid creds can't spam ledger
 * rows for the full 10-min TTL window. The row-create call is wrapped
 * in try/catch; a transient DB glitch now lands on the existing
 * `/settings/integrations?withings=error&reason=connect` surface
 * instead of bubbling a 500. Both rate-limit and create-failure paths
 * redirect rather than returning JSON because the entry point is a
 * browser navigation — a 429 envelope would surface as a blank page.
 */

const CONNECT_RATE_LIMIT = 10;
const CONNECT_WINDOW_MS = 60_000;

export const GET = apiHandler(async (req: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "withings.connect" } });

  const rl = await checkRateLimit(
    `withings:connect:${user.id}`,
    CONNECT_RATE_LIMIT,
    CONNECT_WINDOW_MS,
  );
  if (!rl.allowed) {
    annotate({ action: { name: "withings.connect.rate_limited" } });
    return NextResponse.redirect(
      new URL(
        "/settings/integrations?withings=error&reason=rate_limited",
        req.url,
      ),
    );
  }

  const creds = await getUserWithingsCredentials(user.id);
  if (!creds) {
    return apiError(
      "Please configure your Withings Client ID and Client Secret in Settings first.",
      400,
    );
  }

  const nonce = mintWithingsOAuthStateNonce();
  try {
    await prisma.withingsOAuthState.create({
      data: {
        nonce,
        userId: user.id,
        expiresAt: new Date(Date.now() + WITHINGS_OAUTH_STATE_TTL_MS),
      },
    });
  } catch (err) {
    getEvent()?.setError(err);
    annotate({ action: { name: "withings.connect.create_failed" } });
    return NextResponse.redirect(
      new URL(
        "/settings/integrations?withings=error&reason=connect",
        req.url,
      ),
    );
  }

  const url = getAuthorizationUrl(nonce, creds);

  const response = NextResponse.redirect(url);
  response.cookies.set(WITHINGS_OAUTH_STATE_COOKIE, nonce, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: Math.floor(WITHINGS_OAUTH_STATE_TTL_MS / 1000),
    path: "/",
  });

  return response;
});
