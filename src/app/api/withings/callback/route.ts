import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate, getEvent } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { encrypt } from "@/lib/crypto";
import { exchangeCode, WITHINGS_OAUTH_SCOPE } from "@/lib/withings/client";
import { getUserWithingsCredentials } from "@/lib/withings/credentials";
import { WITHINGS_OAUTH_STATE_COOKIE } from "@/lib/withings/oauth-state";
import { setupWebhook } from "@/lib/withings/sync";
import { markReconnected } from "@/lib/integrations/status";
import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";

/**
 * OAuth callback from Withings. Exchanges code for tokens and stores them.
 *
 * v1.4.47 W6 — `state` is now a fully-random 22-character base64url
 * nonce keyed against the `WithingsOAuthState` ledger, rather than the
 * legacy `${user.id}:${random16}` shape. The user identity bound to
 * the in-flight handshake is resolved via the ledger's `userId`
 * column (no longer parsed from the cookie value) and cross-checked
 * against the session — both must agree before the token exchange
 * runs. The row is consumed (deleted) on every exit branch so a
 * replay of the same nonce fails the second time.
 *
 * Closes the v1.4.43 security audit L-1 finding: the cookie now
 * carries only the opaque nonce, so a future refactor flipping it to
 * non-httpOnly cannot leak the user id into request logs / network
 * captures.
 */
export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "withings.callback" } });

  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const storedState = request.cookies.get(WITHINGS_OAUTH_STATE_COOKIE)?.value;

  // CSRF check, leg 1: URL state must match the cookie state byte-for-byte.
  // Timing-safe comparison so a probe can't recover the cookie bytes via
  // response-time analysis.
  if (
    !state ||
    !storedState ||
    state.length !== storedState.length ||
    !timingSafeEqual(Buffer.from(state), Buffer.from(storedState))
  ) {
    return NextResponse.redirect(
      new URL(
        "/settings/integrations?withings=error&reason=state",
        process.env.NEXT_PUBLIC_APP_URL!,
      ),
    );
  }

  // CSRF check, leg 2: the nonce must resolve to a live, unexpired
  // ledger row whose `userId` matches the authenticated session.
  // Resolving the user from the row (rather than parsing the cookie
  // value) is the v1.4.43 audit recommendation — a future refactor
  // flipping the cookie to non-httpOnly cannot leak the user id this
  // way.
  const stateRow = await prisma.withingsOAuthState.findUnique({
    where: { nonce: state },
  });
  if (
    !stateRow ||
    stateRow.expiresAt <= new Date() ||
    stateRow.userId !== user.id
  ) {
    // Single-use: stamp out the row whether the expiry tripped, the
    // user mismatched, or we found nothing. The user will retry from
    // `withings/connect` with a fresh nonce.
    if (stateRow) {
      await prisma.withingsOAuthState
        .delete({ where: { nonce: state } })
        .catch(() => {});
    }
    return NextResponse.redirect(
      new URL(
        "/settings/integrations?withings=error&reason=state",
        process.env.NEXT_PUBLIC_APP_URL!,
      ),
    );
  }

  if (!code) {
    // Consume the row even on the no-code path so the nonce can't
    // be replayed by an attacker who scraped the redirect URL.
    await prisma.withingsOAuthState
      .delete({ where: { nonce: state } })
      .catch(() => {});
    return NextResponse.redirect(
      new URL(
        "/settings/integrations?withings=error&reason=nocode",
        process.env.NEXT_PUBLIC_APP_URL!,
      ),
    );
  }

  try {
    const creds = await getUserWithingsCredentials(user.id);
    if (!creds) {
      await prisma.withingsOAuthState
        .delete({ where: { nonce: state } })
        .catch(() => {});
      return NextResponse.redirect(
        new URL(
          "/settings/integrations?withings=error&reason=nocreds",
          process.env.NEXT_PUBLIC_APP_URL!,
        ),
      );
    }

    const tokens = await exchangeCode(code, creds);

    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);

    // v1.4.25 W5d — persist the OAuth scope we requested. The token
    // response doesn't echo the granted scopes back as a top-level
    // field, but Withings honours the scope param verbatim — there's
    // no scope downgrade unless the user explicitly revokes one in
    // their Health Mate account, which would fail the token exchange
    // entirely. Storing the requested set is therefore a safe
    // representation of what the connection holds.
    await prisma.withingsConnection.upsert({
      where: { userId: user.id },
      update: {
        withingsUserId: tokens.userid,
        accessToken: encrypt(tokens.access_token),
        refreshToken: encrypt(tokens.refresh_token),
        tokenExpiresAt: expiresAt,
        scope: WITHINGS_OAUTH_SCOPE,
      },
      create: {
        userId: user.id,
        withingsUserId: tokens.userid,
        accessToken: encrypt(tokens.access_token),
        refreshToken: encrypt(tokens.refresh_token),
        tokenExpiresAt: expiresAt,
        scope: WITHINGS_OAUTH_SCOPE,
      },
    });

    // Subscribe to webhooks in background
    setupWebhook(user.id).catch((err) =>
      getEvent()?.addWarning("Webhook setup failed: " + err),
    );

    await auditLog("withings.connect", {
      userId: user.id,
      details: { withingsUserId: tokens.userid },
    });

    // Re-completing OAuth clears any prior `error_reauth` state. We
    // don't write a fresh success-time — that's the next sync's job.
    await markReconnected(user.id, "withings");

    // Consume the ledger row — single-use semantics. From this point
    // on a replay of the same `state` lands on the not-found branch
    // above and redirects to the error page.
    await prisma.withingsOAuthState
      .delete({ where: { nonce: state } })
      .catch(() => {});

    const response = NextResponse.redirect(
      new URL(
        "/settings/integrations?withings=connected",
        process.env.NEXT_PUBLIC_APP_URL!,
      ),
    );
    response.cookies.delete(WITHINGS_OAUTH_STATE_COOKIE);
    return response;
  } catch (err) {
    getEvent()?.setError(err);
    // Consume the row on the failure path too — the user is going to
    // retry from `withings/connect` which mints a fresh nonce, and a
    // stranded row buys us nothing.
    await prisma.withingsOAuthState
      .delete({ where: { nonce: state } })
      .catch(() => {});
    return NextResponse.redirect(
      new URL(
        "/settings/integrations?withings=error&reason=token",
        process.env.NEXT_PUBLIC_APP_URL!,
      ),
    );
  }
});
