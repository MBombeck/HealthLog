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
 *   - Per-IP rate-limited (30 requests / 15 min) so the by-design
 *     enumeration contract cannot be brute-forced. Mirrors the
 *     `/api/auth/passkey/login-options` throttle shape.
 *   - The identifier is queried EXACTLY as iOS sends it (no
 *     `.toLowerCase()` normalisation). Email + username columns are
 *     stored verbatim by `/api/auth/register`, so case-folding here
 *     would route legitimate existing users to the sign-up branch.
 *     A future server-side normalisation pass on register write is
 *     the long-term fix.
 */
import { z } from "zod/v4";
import { prisma } from "@/lib/db";
import { apiSuccess, apiError, safeJson } from "@/lib/api-response";
import { apiHandler } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { hashToken } from "@/lib/auth/hmac";
import {
  checkAuthSurfaceRateLimit,
  rateLimitHeaders,
} from "@/lib/rate-limit";
import { NextResponse } from "next/server";
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
  // v1.4.43 W13 M-4 — tighter shared bucket on trust-chain misconfig.
  const rl = await checkAuthSurfaceRateLimit(
    request,
    "auth:check-user",
    30,
    15 * 60 * 1000,
  );
  const ip = rl.ip ?? "unknown";
  if (!rl.allowed) {
    return NextResponse.json(
      { data: null, error: "Too many requests. Please try again later." },
      { status: 429, headers: rateLimitHeaders(rl) },
    );
  }

  const { data: body, error: jsonError } = await safeJson(request);
  if (jsonError) return jsonError;

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return apiError("identifier required", 422);
  }

  const identifier = parsed.data.identifier;

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

  // v1.4.43 W13 M-1 — persist a hashed-identifier audit row so an admin
  // can later answer "did anyone enumerate accounts last week?". The
  // wide-event `annotate()` log is sampled and short-retention; the
  // audit ledger is durable. We hash the identifier (same shape as the
  // `auth.login.failed` row) so the literal email/username never lands
  // in `AuditLog.details` — the v1.4.20 retroactive PII directive bars
  // raw user-typed strings from operator-readable artefacts.
  const identifierHash = hashToken(identifier);

  if (!user) {
    annotate({ action: { name: "auth.check-user" }, meta: { branch: "not_found" } });
    await auditLog("auth.check-user", {
      ipAddress: ip,
      details: { branch: "not_found", identifier_hash: identifierHash },
    });
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
  await auditLog("auth.check-user", {
    userId: user.id,
    ipAddress: ip,
    details: { branch, identifier_hash: identifierHash },
  });
  return apiSuccess({ branch, hasPasskey, hasPassword });
});
