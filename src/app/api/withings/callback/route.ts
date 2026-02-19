import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { auditLog } from "@/lib/auth/audit";
import { encrypt } from "@/lib/crypto";
import { exchangeCode } from "@/lib/withings/client";
import { getUserWithingsCredentials } from "@/lib/withings/credentials";
import { setupWebhook } from "@/lib/withings/sync";
import { NextRequest, NextResponse } from "next/server";

/**
 * OAuth callback from Withings. Exchanges code for tokens and stores them.
 */
export async function GET(request: NextRequest) {
  const sessionData = await getSession();
  if (!sessionData) {
    const loginUrl = new URL("/auth/login", request.url);
    loginUrl.searchParams.set(
      "next",
      `${request.nextUrl.pathname}${request.nextUrl.search}`,
    );
    return NextResponse.redirect(loginUrl);
  }

  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const storedState = request.cookies.get("withings_state")?.value;

  // CSRF check
  if (!state || !storedState || state !== storedState) {
    return NextResponse.redirect(
      new URL(
        "/settings?withings=error&reason=state",
        process.env.NEXT_PUBLIC_APP_URL!,
      ),
    );
  }

  // Verify state contains current user's ID
  const [stateUserId] = state.split(":");
  if (stateUserId !== sessionData.user.id) {
    return NextResponse.redirect(
      new URL(
        "/settings?withings=error&reason=user",
        process.env.NEXT_PUBLIC_APP_URL!,
      ),
    );
  }

  if (!code) {
    return NextResponse.redirect(
      new URL(
        "/settings?withings=error&reason=nocode",
        process.env.NEXT_PUBLIC_APP_URL!,
      ),
    );
  }

  try {
    const creds = await getUserWithingsCredentials(sessionData.user.id);
    if (!creds) {
      return NextResponse.redirect(
        new URL(
          "/settings?withings=error&reason=nocreds",
          process.env.NEXT_PUBLIC_APP_URL!,
        ),
      );
    }

    const tokens = await exchangeCode(code, creds);

    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);

    // Upsert connection (user may be reconnecting)
    await prisma.withingsConnection.upsert({
      where: { userId: sessionData.user.id },
      update: {
        withingsUserId: tokens.userid,
        accessToken: encrypt(tokens.access_token),
        refreshToken: encrypt(tokens.refresh_token),
        tokenExpiresAt: expiresAt,
      },
      create: {
        userId: sessionData.user.id,
        withingsUserId: tokens.userid,
        accessToken: encrypt(tokens.access_token),
        refreshToken: encrypt(tokens.refresh_token),
        tokenExpiresAt: expiresAt,
      },
    });

    // Subscribe to webhooks in background
    setupWebhook(sessionData.user.id).catch(console.error);

    await auditLog("withings.connect", {
      userId: sessionData.user.id,
      details: { withingsUserId: tokens.userid },
    });

    const response = NextResponse.redirect(
      new URL("/settings?withings=connected", process.env.NEXT_PUBLIC_APP_URL!),
    );
    response.cookies.delete("withings_state");
    return response;
  } catch (err) {
    console.error("[withings] Callback error:", err);
    return NextResponse.redirect(
      new URL(
        "/settings?withings=error&reason=token",
        process.env.NEXT_PUBLIC_APP_URL!,
      ),
    );
  }
}
