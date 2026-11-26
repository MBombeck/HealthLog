import { NextRequest, NextResponse } from "next/server";

import { apiSuccess } from "@/lib/api-response";
import { apiHandler } from "@/lib/api-handler";
import { parseJsonBody } from "@/lib/api/body";
import { estimatePasswordStrength } from "@/lib/auth/password";
import { annotate } from "@/lib/logging/context";
import { checkAuthSurfaceRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { passwordStrengthRequestSchema } from "@/lib/validations/auth";

/**
 * Per address and minute. The meter asks once typing pauses for 200 ms, so a
 * person filling in a form spends a handful of requests; an address that
 * needs more is not typing.
 */
const REQUESTS_PER_MINUTE = 20;

/**
 * Scores a password for the strength meter on the registration, profile-claim
 * and admin reset forms. Anonymous, because the person registering has no
 * session yet. It stores nothing, compares against no account and annotates
 * nothing about the password; it only runs the estimator the registration
 * route runs on submit, so the browser does not have to download its
 * dictionaries.
 *
 * The estimator runs on the request thread, so its cost is bounded where it
 * is called (`passwordEstimateInput`): at most `PASSWORD_STRENGTH_MAX_LENGTH`
 * characters, and the schema refuses anything longer. Rate limited per
 * address before the body is read, with an untrusted forwarding chain
 * collapsed into the shared anonymous bucket; a cross-site browser POST is
 * refused by `apiHandler` before this runs.
 */
export const POST = apiHandler(async (request: NextRequest) => {
  const rl = await checkAuthSurfaceRateLimit(
    request,
    "auth:password-strength",
    REQUESTS_PER_MINUTE,
    60 * 1000,
  );
  if (!rl.allowed) {
    return NextResponse.json(
      { data: null, error: "Too many attempts. Please try again later." },
      { status: 429, headers: rateLimitHeaders(rl) },
    );
  }

  const parsed = await parseJsonBody(request, passwordStrengthRequestSchema, {
    maxBytes: 512,
  });
  if (!parsed.ok) return parsed.error;

  annotate({ action: { name: "auth.password-strength.estimate" } });
  return apiSuccess(estimatePasswordStrength(parsed.data.password));
});
