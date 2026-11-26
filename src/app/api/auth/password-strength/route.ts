import { NextRequest, NextResponse } from "next/server";

import { apiSuccess } from "@/lib/api-response";
import { apiHandler } from "@/lib/api-handler";
import { parseJsonBody } from "@/lib/api/body";
import { estimatePasswordStrength } from "@/lib/auth/password";
import { annotate } from "@/lib/logging/context";
import { checkAuthSurfaceRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { passwordStrengthRequestSchema } from "@/lib/validations/auth";

/**
 * Scores a password for the strength meter on the registration, profile-claim
 * and admin reset forms. Anonymous, because the person registering has no
 * session yet. It stores nothing, compares against no account and annotates
 * nothing about the password; it only runs the estimator the registration
 * route runs on submit, so the browser does not have to download its
 * dictionaries.
 *
 * Rate limited per address before the body is read. The meter waits for a
 * pause in typing before it asks, so a person entering a password spends a
 * handful of requests, not one per key.
 */
export const POST = apiHandler(async (request: NextRequest) => {
  const rl = await checkAuthSurfaceRateLimit(
    request,
    "auth:password-strength",
    60,
    60 * 1000,
  );
  if (!rl.allowed) {
    return NextResponse.json(
      { data: null, error: "Too many attempts. Please try again later." },
      { status: 429, headers: rateLimitHeaders(rl) },
    );
  }

  const parsed = await parseJsonBody(request, passwordStrengthRequestSchema, {
    maxBytes: 4 * 1024,
  });
  if (!parsed.ok) return parsed.error;

  annotate({ action: { name: "auth.password-strength.estimate" } });
  return apiSuccess(estimatePasswordStrength(parsed.data.password));
});
