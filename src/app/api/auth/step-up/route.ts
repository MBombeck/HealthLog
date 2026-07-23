/**
 * POST /api/auth/step-up
 *
 * Re-prove a factor and receive a single-use, token-bound step-up elevation for
 * one second-factor-management call.
 *
 * WHICH factor is re-proved decides WHAT the elevation reaches. `password`
 * reaches exactly what a plain cookie session reaches. `totp`, `webauthn`, and
 * `passkey` additionally satisfy the fresh-factor routes — disable, recovery-code
 * rotation, security-key removal — and that set is precisely the set of
 * ceremonies for which the web stamps a session second-factor-verified. If a
 * password-proved elevation opened those routes, a stolen token plus the account
 * password would rotate the recovery codes (which take no factor in the body)
 * and then spend one of them to disable the second factor outright.
 *
 * This is the whole point of the mechanism, so it is worth being blunt about
 * what it is not: it is NOT a way to turn a token into a stronger credential.
 * Presenting the token gets you as far as this endpoint and no further — the
 * body must carry a fresh proof of the account password or of a primary passkey
 * the device holds. A stolen token can call this all day and mint nothing.
 *
 * Bearer-only (`requireBearerAuth`). A browser cannot reach it even with a valid
 * session, which keeps an ambient cookie credential out of the mint path
 * entirely.
 *
 * Failures are deliberately indistinguishable. A wrong password, an account with
 * no password set, a passkey belonging to someone else, a stale challenge — all
 * return the same 401 with the same prose. The audit row carries the real reason;
 * the wire carries none of it.
 */
import { NextRequest } from "next/server";
import { apiHandler, requireBearerAuth } from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  getClientIp,
  safeJson,
} from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import {
  checkAuthSurfaceRateLimit,
  checkRateLimit,
  rateLimitHeaders,
} from "@/lib/rate-limit";
import { verifyPassword } from "@/lib/auth/password";
import { verifyAuthentication } from "@/lib/auth/passkey";
import { verifyMfaAuthentication } from "@/lib/auth/mfa/webauthn";
import { verifyMfaFactor } from "@/lib/auth/mfa/verify-factor";
import {
  mintStepUpElevation,
  isFreshFactorMethod,
  STEP_UP_ELEVATION_TTL_SECONDS,
  type StepUpMethod,
} from "@/lib/auth/step-up";
import { stepUpMintSchema } from "@/lib/validations/step-up";

export const dynamic = "force-dynamic";

/**
 * Per-account ceiling. Tight because the password arm runs an Argon2id verify
 * against a user-supplied string — the same 5-per-15-minutes the password-change
 * route uses, for the same reason.
 */
const MINT_LIMIT = 5;
const MINT_WINDOW_MS = 15 * 60 * 1000;

export const POST = apiHandler(async (request: NextRequest) => {
  const auth = await requireBearerAuth();
  const { user } = auth;
  // `requireAuth`'s contract puts the resolved `ApiToken` row id here. It is the
  // binding the minted elevation is tied to.
  const apiTokenId = auth.session.id;
  const ip = getClientIp(request);

  // Two buckets. The per-IP surface bucket collapses to the tight shared anon
  // bucket when the proxy trust chain is broken, so a misconfigured deployment
  // caps a spray rather than opening one.
  const ipRl = await checkAuthSurfaceRateLimit(
    request,
    "auth:step-up",
    20,
    MINT_WINDOW_MS,
  );
  if (!ipRl.allowed) {
    return apiError("Too many attempts. Please try again later.", 429, {
      headers: rateLimitHeaders(ipRl),
    });
  }

  const userRl = await checkRateLimit(
    `auth:step-up:${user.id}`,
    MINT_LIMIT,
    MINT_WINDOW_MS,
  );
  if (!userRl.allowed) {
    await auditLog("auth.stepup.mint.rate_limited", {
      userId: user.id,
      ipAddress: ip,
    });
    annotate({ action: { name: "auth.stepup.mint.rate_limited" } });
    return apiError("Too many attempts. Please wait 15 minutes.", 429, {
      headers: rateLimitHeaders(userRl),
    });
  }

  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: 64 * 1024,
  });
  if (jsonError) return jsonError;

  const parsed = stepUpMintSchema.safeParse(body);
  if (!parsed.success) {
    return apiError("Invalid request", 422);
  }

  const method: StepUpMethod = parsed.data.method;
  let proved = false;
  // Audit-only detail. Never reaches the response — see the file header.
  let failure = "invalid";

  /**
   * Resolve a WebAuthn challenge and confirm it belongs to THIS account before
   * any verification runs. Both ceremony helpers resolve a challenge by id
   * alone, so without this a challenge minted for another account could be
   * carried into the ceremony.
   */
  const challengeBelongsToCaller = async (id: string): Promise<boolean> => {
    const row = await prisma.authChallenge.findUnique({
      where: { id },
      select: { userId: true },
    });
    return Boolean(row && row.userId === user.id);
  };

  if (parsed.data.method === "password") {
    if (!user.passwordHash) {
      // An SSO-provisioned account has no password to re-prove. Same refusal as
      // a wrong one: the account's credential shape is not a token holder's to
      // enumerate. `/api/auth/step-up/options` is the honest discovery path —
      // it 409s when there is no credential of the requested kind either.
      failure = "no_password";
    } else {
      proved = await verifyPassword(user.passwordHash, parsed.data.password);
      if (!proved) failure = "bad_password";
    }
  } else if (parsed.data.method === "totp") {
    // The shared factor verifier, so the replay guard and the accepted-step
    // burn behave exactly as they do at login and at MFA-disable. A code spent
    // here cannot be replayed there.
    const result = await verifyMfaFactor(user, "totp", parsed.data.code);
    proved = result.ok;
    if (!proved) failure = result.replay ? "totp_replay" : "bad_totp";
  } else if (parsed.data.method === "webauthn") {
    if (!(await challengeBelongsToCaller(parsed.data.challengeId))) {
      failure = "foreign_challenge";
    } else {
      try {
        // Scoped to the caller's own second-factor credentials by the verifier.
        proved = await verifyMfaAuthentication(
          parsed.data.challengeId,
          user.id,
          parsed.data.credential,
        );
        if (!proved) failure = "bad_assertion";
      } catch {
        // A malformed / expired challenge is a failed attempt, not a 500.
        failure = "bad_assertion";
      }
    }
  } else {
    if (!(await challengeBelongsToCaller(parsed.data.challengeId))) {
      failure = "foreign_challenge";
    } else {
      try {
        const result = await verifyAuthentication(
          parsed.data.challengeId,
          parsed.data.credential,
        );
        // Both halves matter: a verified assertion against SOMEONE ELSE'S
        // passkey proves possession of a factor, just not of this account's.
        proved =
          result.verification.verified && result.passkey.userId === user.id;
        if (!proved) failure = "bad_assertion";
      } catch {
        failure = "bad_assertion";
      }
    }
  }

  if (!proved) {
    await auditLog("auth.stepup.mint.failed", {
      userId: user.id,
      ipAddress: ip,
      details: { method: parsed.data.method, reason: failure },
    });
    annotate({
      action: { name: "auth.stepup.mint.failed" },
      meta: { method: parsed.data.method, reason: failure },
    });
    return apiError("Verification failed", 401);
  }

  const { token, expiresAt } = await mintStepUpElevation({
    userId: user.id,
    apiTokenId,
    method,
  });

  await auditLog("auth.stepup.mint.succeeded", {
    userId: user.id,
    ipAddress: ip,
    details: { method },
  });
  annotate({
    action: { name: "auth.stepup.mint.succeeded" },
    meta: { method },
  });

  // `elevation` is the raw secret and is returned exactly once. It is never
  // persisted in plaintext and never logged — no wide-event field carries a
  // response body, and `redactSecrets` holds an `hle_` rule regardless.
  return apiSuccess({
    elevation: token,
    expiresAt: expiresAt.toISOString(),
    expiresInSeconds: STEP_UP_ELEVATION_TTL_SECONDS,
    method,
    // Whether this elevation reaches the fresh-factor routes (disable,
    // recovery-code rotation, security-key removal). A password-proved
    // elevation does not, exactly as a password login does not on the web.
    // Surfaced so the client can pick the right ceremony up front instead of
    // discovering the refusal after spending a proof.
    satisfiesFreshFactor: isFreshFactorMethod(method),
  });
});
