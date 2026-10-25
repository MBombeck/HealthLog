import { createAuthenticationOptions } from "@/lib/auth/passkey";
import {
  apiSuccess,
  apiError,
  safeJson,
  isJsonContentType,
} from "@/lib/api-response";
import { checkAuthSurfaceRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { NextResponse } from "next/server";
import { apiHandler } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { isOidcOnly } from "@/lib/auth/oidc";
import { refuseWhenCookieCannotStick } from "@/lib/auth/transport-refusal";

export const POST = apiHandler(async (request: Request) => {
  // OIDC_ONLY must block passkey login too, not just password login.
  if (isOidcOnly()) {
    return apiError("Passkey login is disabled. Sign in with SSO.", 403, {
      errorCode: "oidc_only",
    });
  }

  // v1.4.43 — tighter shared bucket on trust-chain misconfig.
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

  // The body is optional (the web client sends its page transport; nothing
  // else needs to send anything). A missing or unreadable body is no body, as
  // before; only a stated plain-http page refuses, before a challenge exists.
  if (isJsonContentType(request.headers.get("content-type"))) {
    const { data: body } = await safeJson(request, { maxBytes: 4 * 1024 });
    const transportRefusal = refuseWhenCookieCannotStick(body);
    if (transportRefusal) return transportRefusal;
  }

  const { options, challengeId } = await createAuthenticationOptions();

  annotate({ action: { name: "auth.passkey.login-options" } });

  return apiSuccess({ options, challengeId });
});
