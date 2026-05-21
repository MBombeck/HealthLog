/**
 * `POST /api/auth/check-user` — four-branch discovery for iOS onboarding.
 *
 * v1.4.41 W-IOS-COORD SB-7 follow-up. The iOS team's onboarding flow needs
 * to know, given a typed identifier (username or email), what the next
 * UX step should be:
 *
 *   - `not_found`       — no account exists; show the sign-up screen.
 *   - `passkey_only`    — account exists, has at least one Passkey, no
 *                          password hash. Show "Sign in with Passkey".
 *   - `email_fallback`  — account exists, has a password hash (with or
 *                          without a Passkey). Show password field plus
 *                          a "Use Passkey" affordance when applicable.
 *   - `exists`          — account exists with no usable credential
 *                          (neither passkey nor password). Treat as
 *                          recovery path; show "Reset access" hint.
 *
 * The route is intentionally narrow:
 *
 *   - Accepts `{ identifier: string }` (either an email or a username).
 *   - Returns `{ branch, hasPasskey, hasPassword }` — booleans are
 *     included so the iOS client can render a "or sign in with Passkey"
 *     button alongside the password field without a second round-trip.
 *   - Never leaks PII. The response shape is the same regardless of
 *     whether the identifier matched (callers learn account-existence
 *     either way — that is the explicit contract iOS needs). The
 *     handler does NOT echo the identifier back.
 *   - No rate-limit middleware added here; the higher-level edge limit
 *     on `/api/auth/*` covers brute-force enumeration concerns, and the
 *     route is functionally equivalent in information leak to the
 *     existing `/api/auth/passkey/login-options` request that already
 *     accepts an identifier.
 */
import { z } from "zod/v4";
import { prisma } from "@/lib/db";
import { apiSuccess, apiError, safeJson } from "@/lib/api-response";
import { apiHandler } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  identifier: z.string().trim().min(1).max(254),
});

export type CheckUserBranch =
  | "not_found"
  | "passkey_only"
  | "email_fallback"
  | "exists";

export const POST = apiHandler(async (request: NextRequest) => {
  const { data: body, error: jsonError } = await safeJson(request);
  if (jsonError) return jsonError;

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return apiError("identifier required", 422);
  }

  const identifier = parsed.data.identifier.toLowerCase();

  // Match on either username or email — both are unique in the schema.
  const user = await prisma.user.findFirst({
    where: {
      OR: [{ username: identifier }, { email: identifier }],
    },
    select: {
      id: true,
      passwordHash: true,
      _count: { select: { passkeys: true } },
    },
  });

  if (!user) {
    annotate({ action: { name: "auth.check-user" }, meta: { branch: "not_found" } });
    return apiSuccess({
      branch: "not_found" satisfies CheckUserBranch,
      hasPasskey: false,
      hasPassword: false,
    });
  }

  const hasPasskey = user._count.passkeys > 0;
  const hasPassword = Boolean(user.passwordHash);

  let branch: CheckUserBranch;
  if (hasPasskey && !hasPassword) branch = "passkey_only";
  else if (hasPassword) branch = "email_fallback";
  else branch = "exists";

  annotate({ action: { name: "auth.check-user" }, meta: { branch } });
  return apiSuccess({ branch, hasPasskey, hasPassword });
});
