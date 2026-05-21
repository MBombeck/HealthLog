import { createAuthenticationOptions } from "@/lib/auth/passkey";
import { apiSuccess } from "@/lib/api-response";
import {
  checkAuthSurfaceRateLimit,
  rateLimitHeaders,
} from "@/lib/rate-limit";
import { NextResponse } from "next/server";
import { apiHandler } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";

export const POST = apiHandler(async (request: Request) => {
  // v1.4.43 W13 M-4 — tighter shared bucket on trust-chain misconfig.
  const rl = await checkAuthSurfaceRateLimit(
    request,
    "auth:passkey-login-options",
    10,
    15 * 60 * 1000,
  );
  if (!rl.allowed) {
    return NextResponse.json(
      {
        data: null,
        error: "Too many passkey requests. Please try again later.",
      },
      { status: 429, headers: rateLimitHeaders(rl) },
    );
  }

  const { options, challengeId } = await createAuthenticationOptions();

  annotate({ action: { name: "auth.passkey.login-options" } });

  return apiSuccess({ options, challengeId });
});
