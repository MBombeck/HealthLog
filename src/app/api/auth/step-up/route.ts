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
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import {
  checkAuthSurfaceRateLimit,
  checkRateLimit,
  rateLimitHeaders,
} from "@/lib/rate-limit";
import {
  REPROOF_LIMIT,
  REPROOF_WINDOW_MS,
  reproofBucket,
  verifyExistingFactorProof,
} from "@/lib/auth/existing-factor-proof";
import {
  mintStepUpElevation,
  STEP_UP_ELEVATION_TTL_SECONDS,
} from "@/lib/auth/step-up";
import {
  isFreshFactorMethod,
  type StepUpMethod,
} from "@/lib/auth/step-up-factors";
import { stepUpMintSchema } from "@/lib/validations/step-up";

export const dynamic = "force-dynamic";

/**
 * Per-account ceiling. Tight because the password arm runs an Argon2id verify
 * against a user-supplied string — the same 5-per-15-minutes the password-change
 * route uses, for the same reason.
 */
const MINT_LIMIT = REPROOF_LIMIT;
const MINT_WINDOW_MS = REPROOF_WINDOW_MS;

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

  // The account's shared re-proof bucket: a guess spent here is a guess the
  // web enrollment surfaces cannot spend again, and the other way round.
  const userRl = await checkRateLimit(
    reproofBucket(user.id),
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

  const parsed = await parseJsonBody(request, stepUpMintSchema, {
    maxBytes: 64 * 1024,
    message: "Invalid request",
  });
  if (!parsed.ok) return parsed.error;

  const method: StepUpMethod = parsed.data.method;
  // The shared verifier: the same challenge ownership and ceremony checks, and
  // the same confirmed-secret rule for TOTP, as every other re-proof surface.
  // The replay guard and the accepted-step burn behave exactly as they do at
  // login and at MFA-disable, so a code spent here cannot be replayed there.
  const outcome = await verifyExistingFactorProof(user, parsed.data);
  const proved = outcome.ok;
  // Audit-only detail. Never reaches the response — see the file header.
  const failure = outcome.ok ? "" : outcome.reason;

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
