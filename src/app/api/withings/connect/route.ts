import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { getAuthorizationUrl } from "@/lib/withings/client";
import { getUserWithingsCredentials } from "@/lib/withings/credentials";
import {
  WITHINGS_OAUTH_STATE_COOKIE,
  WITHINGS_OAUTH_STATE_TTL_MS,
  mintWithingsOAuthStateNonce,
} from "@/lib/withings/oauth-state";
import { NextResponse } from "next/server";

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
 */
export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "withings.connect" } });

  const creds = await getUserWithingsCredentials(user.id);
  if (!creds) {
    return apiError(
      "Please configure your Withings Client ID and Client Secret in Settings first.",
      400,
    );
  }

  const nonce = mintWithingsOAuthStateNonce();
  await prisma.withingsOAuthState.create({
    data: {
      nonce,
      userId: user.id,
      expiresAt: new Date(Date.now() + WITHINGS_OAUTH_STATE_TTL_MS),
    },
  });

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
