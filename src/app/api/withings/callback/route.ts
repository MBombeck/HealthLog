import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate, getEvent } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { encrypt } from "@/lib/crypto";
import { exchangeCode, WITHINGS_OAUTH_SCOPE } from "@/lib/withings/client";
import { getUserWithingsCredentials } from "@/lib/withings/credentials";
import { setupWebhook } from "@/lib/withings/sync";
import { markReconnected } from "@/lib/integrations/status";
import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";

/**
 * OAuth callback from Withings. Exchanges code for tokens and stores them.
 */
export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "withings.callback" } });

  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const storedState = request.cookies.get("withings_state")?.value;

  // CSRF check (timing-safe comparison to prevent timing attacks)
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

  // Verify state contains current user's ID
  const [stateUserId] = state.split(":");
  if (stateUserId !== user.id) {
    return NextResponse.redirect(
      new URL(
        "/settings/integrations?withings=error&reason=user",
        process.env.NEXT_PUBLIC_APP_URL!,
      ),
    );
  }

  if (!code) {
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

    const response = NextResponse.redirect(
      new URL(
        "/settings/integrations?withings=connected",
        process.env.NEXT_PUBLIC_APP_URL!,
      ),
    );
    response.cookies.delete("withings_state");
    return response;
  } catch (err) {
    getEvent()?.setError(err);
    return NextResponse.redirect(
      new URL(
        "/settings/integrations?withings=error&reason=token",
        process.env.NEXT_PUBLIC_APP_URL!,
      ),
    );
  }
});
