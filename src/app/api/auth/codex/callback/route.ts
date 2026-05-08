import { NextRequest, NextResponse } from "next/server";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { checkRateLimit } from "@/lib/rate-limit";
import { exchangeCodeForTokens, encryptTokens } from "@/lib/ai/codex-oauth";
import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import { getClientIp } from "@/lib/api-response";
import { cookies } from "next/headers";
import { annotate } from "@/lib/logging/context";

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const rl = await checkRateLimit(`codex-callback:${user.id}`, 10, 60_000);
  if (!rl.allowed) {
    const appUrl = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL;
    return NextResponse.redirect(`${appUrl}/settings/integrations?codex_error=rate_limited`);
  }

  const url = new URL(request.url);

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  const appUrl = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl) throw new Error("APP_URL not configured");

  if (error) {
    annotate({ meta: { oauth_error: error } });
    return NextResponse.redirect(
      `${appUrl}/settings/integrations?codex_error=${encodeURIComponent(error)}`,
    );
  }

  if (!code || !state) {
    return NextResponse.redirect(
      `${appUrl}/settings/integrations?codex_error=missing_params`,
    );
  }

  const cookieStore = await cookies();
  const storedState = cookieStore.get("codex_state")?.value;
  const storedVerifier = cookieStore.get("codex_verifier")?.value;

  cookieStore.delete("codex_state");
  cookieStore.delete("codex_verifier");

  if (!storedState || !storedVerifier || state !== storedState) {
    return NextResponse.redirect(
      `${appUrl}/settings/integrations?codex_error=invalid_state`,
    );
  }

  const redirectUri = `${appUrl}/api/auth/codex/callback`;

  try {
    const tokens = await exchangeCodeForTokens({
      code,
      codeVerifier: storedVerifier,
      redirectUri,
    });
    const encrypted = encryptTokens({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
    });

    await prisma.user.update({
      where: { id: user.id },
      data: {
        codexAccessTokenEncrypted: encrypted.accessEncrypted,
        codexRefreshTokenEncrypted: encrypted.refreshEncrypted,
        codexTokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000),
        codexConnectedAt: new Date(),
        codexConnectionStatus: "connected",
        insightsCachedAt: null,
        insightsCachedText: null,
      },
    });

    await auditLog("codex.oauth.connected", {
      userId: user.id,
      ipAddress: getClientIp(request),
    });
    annotate({ action: { name: "codex.oauth.callback.success" } });

    return NextResponse.redirect(
      `${appUrl}/settings/integrations?codex_connected=true`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    annotate({ meta: { codex_token_error: message } });
    return NextResponse.redirect(
      `${appUrl}/settings/integrations?codex_error=token_exchange_failed`,
    );
  }
});
