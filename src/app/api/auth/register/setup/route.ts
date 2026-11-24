import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { apiError, apiSuccess } from "@/lib/api-response";
import { apiHandler } from "@/lib/api-handler";
import { parseJsonBody } from "@/lib/api/body";
import { setupTokenSchema } from "@/lib/validations/auth";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { checkAuthSurfaceRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import {
  isSetupToken,
  mintSetupProof,
  SETUP_PROOF_COOKIE,
  setupProofCookieOptions,
} from "@/lib/auth/setup-token";

/**
 * Prove the setup token of an instance without an account
 * (`@/lib/auth/setup-token`). The answer is a short-lived httpOnly cookie that
 * lets this browser create the first account, by the registration form or by
 * a single sign-on. Rate limited before the token is compared, like every
 * anonymous auth surface.
 */
export const POST = apiHandler(async (request: NextRequest) => {
  const rl = await checkAuthSurfaceRateLimit(
    request,
    "auth:setup",
    5,
    15 * 60 * 1000,
  );
  if (!rl.allowed) {
    return NextResponse.json(
      { data: null, error: "Too many attempts. Please try again later." },
      { status: 429, headers: rateLimitHeaders(rl) },
    );
  }

  if ((await prisma.user.count()) > 0) {
    return apiError("This server already has an account", 409, {
      errorCode: "auth.setup.already_claimed",
    });
  }

  const parsed = await parseJsonBody(request, setupTokenSchema, {
    maxBytes: 4 * 1024,
  });
  if (!parsed.ok) return parsed.error;

  const ip = rl.ip ?? "unknown";
  if (!isSetupToken(parsed.data.setupToken)) {
    await auditLog("auth.setup.rejected", { ipAddress: ip });
    annotate({ action: { name: "auth.setup.rejected" } });
    return apiError("That is not this server's setup token", 403, {
      errorCode: "auth.setup.token_invalid",
    });
  }

  (await cookies()).set(
    SETUP_PROOF_COOKIE,
    mintSetupProof(),
    setupProofCookieOptions(),
  );
  await auditLog("auth.setup.proven", { ipAddress: ip });
  annotate({ action: { name: "auth.setup.proven" } });
  return apiSuccess({ proven: true });
});
