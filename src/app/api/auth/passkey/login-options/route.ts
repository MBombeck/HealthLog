import { createAuthenticationOptions } from "@/lib/auth/passkey";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const ip = getClientIp(request) ?? "unknown";
  const rl = checkRateLimit(`auth:passkey-login-options:${ip}`, 10, 15 * 60 * 1000);
  if (!rl.allowed) {
    return NextResponse.json(
      {
        data: null,
        error: "Zu viele Passkey-Anfragen. Bitte später erneut versuchen.",
      },
      { status: 429, headers: rateLimitHeaders(rl) },
    );
  }

  try {
    const { options, challengeId } = await createAuthenticationOptions();

    return apiSuccess({ options, challengeId });
  } catch (err) {
    console.error("Passkey login-options error:", err);
    return apiError("Konnte Passkey-Optionen nicht erzeugen", 500);
  }
}
