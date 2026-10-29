/**
 * Re-proving a credential the account already holds.
 *
 * Several surfaces accept a fresh proof in the request body before they act:
 * the Bearer step-up mint, the primary-passkey enrollment, TOTP enrollment and
 * security-key enrollment. They used to verify it each in their own way, and
 * the copies drifted — one checked who owned a WebAuthn challenge but not its
 * type, one had no rate limit and wrote no audit row for a wrong password, so
 * a stolen session could guess the password or a TOTP code there without
 * limit and without trace. This module is the one verifier and the one
 * throttle, so every surface refuses, counts and records a failed proof the
 * same way.
 *
 * The throttle is ONE bucket per account shared by every surface: five proofs
 * in fifteen minutes, the ceiling the step-up mint has used since it shipped
 * (same key, so its counter carries straight over). A shared bucket means a
 * guesser cannot multiply the budget by rotating between routes.
 */
import { prisma } from "@/lib/db";
import { apiError, isJsonContentType } from "@/lib/api-response";
import { REPROOF_REQUIRED_CODE } from "@/lib/api-errors";
import { auditLog } from "@/lib/auth/audit";
import { annotate } from "@/lib/logging/context";
import {
  checkRateLimit,
  rateLimitHeaders,
  refundRateLimit,
} from "@/lib/rate-limit";
import {
  hasSecondFactorEnrolled,
  recentProofMethods,
  type RecentProofMethod,
} from "@/lib/auth/second-factor";
import { verifyPassword } from "@/lib/auth/password";
import { verifyAuthentication } from "@/lib/auth/passkey";
import { verifyMfaAuthentication } from "@/lib/auth/mfa/webauthn";
import { loadFactorUser, verifyMfaFactor } from "@/lib/auth/mfa/verify-factor";
import {
  stepUpMintSchema,
  type StepUpMintRequest,
} from "@/lib/validations/step-up";

export type ExistingFactorProof = StepUpMintRequest;

export const REPROOF_LIMIT = 5;
export const REPROOF_WINDOW_MS = 15 * 60 * 1000;

/** The per-account bucket every re-proof surface draws from. */
export function reproofBucket(userId: string): string {
  return `auth:step-up:${userId}`;
}

/**
 * Charge one attempt to the account's re-proof bucket. Returns the 429 to send
 * when the bucket is empty (and writes the audit row), or null to proceed.
 * Call it only when a proof is actually about to be verified, so a request that
 * needs no proof does not spend one.
 */
export async function throttleReproof(
  userId: string,
  ipAddress: string | null,
  stage: string,
): Promise<Response | null> {
  const rl = await checkRateLimit(
    reproofBucket(userId),
    REPROOF_LIMIT,
    REPROOF_WINDOW_MS,
  );
  if (rl.allowed) return null;
  await auditLog("auth.reproof.rate_limited", {
    userId,
    ipAddress,
    details: { stage },
  });
  annotate({
    action: { name: "auth.reproof.rate_limited" },
    meta: { stage },
  });
  return apiError("Too many attempts. Please wait 15 minutes.", 429, {
    headers: rateLimitHeaders(rl),
  });
}

/**
 * Give back the attempt a proof charged once it verified. The bucket exists to
 * stop guessing; a proof that verified was not a guess, and without the refund
 * an owner who confirms a few actions in a row (an export, a share link, a
 * password change) runs the shared budget dry and is told to wait.
 */
export async function refundReproof(userId: string): Promise<void> {
  await refundRateLimit(reproofBucket(userId));
}

export type ProofOutcome = { ok: true } | { ok: false; reason: string };

/** The caller a proof is checked for: who they are and whether TOTP is live. */
type ProofUser = { id: string; totpConfirmedAt: Date | null };

/**
 * Verify a proof against the account. Never throws for a bad proof: a
 * malformed or expired WebAuthn challenge is a failed attempt, not a 500.
 *
 * A WebAuthn challenge must belong to this account AND be of the ceremony the
 * method names, because both ceremony helpers resolve a challenge by id alone.
 * A TOTP code is accepted only from a confirmed secret (`verifyMfaFactor`).
 */
export async function verifyExistingFactorProof(
  user: ProofUser,
  proof: ExistingFactorProof,
): Promise<ProofOutcome> {
  // The secrets are read here, for this one check: the caller's row is the
  // per-request projection, which carries none of them.
  if (proof.method === "password") {
    const row = await prisma.user.findUnique({
      where: { id: user.id },
      select: { passwordHash: true },
    });
    if (!row?.passwordHash) return { ok: false, reason: "no_password" };
    const ok = await verifyPassword(row.passwordHash, proof.password);
    return ok ? { ok } : { ok: false, reason: "bad_password" };
  }

  if (proof.method === "totp") {
    const factorUser = await loadFactorUser(user.id);
    if (!factorUser) return { ok: false, reason: "bad_totp" };
    const result = await verifyMfaFactor(factorUser, "totp", proof.code);
    if (result.ok) return { ok: true };
    return { ok: false, reason: result.replay ? "totp_replay" : "bad_totp" };
  }

  const expectedType =
    proof.method === "passkey" ? "authentication" : "mfa_authentication";
  const challenge = await prisma.authChallenge.findUnique({
    where: { id: proof.challengeId },
    select: { userId: true, type: true },
  });
  if (!challenge || challenge.userId !== user.id) {
    return { ok: false, reason: "foreign_challenge" };
  }
  if (challenge.type !== expectedType) {
    return { ok: false, reason: "wrong_ceremony" };
  }

  try {
    if (proof.method === "passkey") {
      const result = await verifyAuthentication(
        proof.challengeId,
        proof.credential,
      );
      // Both halves matter: a verified assertion against SOMEONE ELSE'S passkey
      // proves possession of a factor, just not of this account's.
      const ok =
        result.verification.verified && result.passkey.userId === user.id;
      return ok ? { ok } : { ok: false, reason: "bad_assertion" };
    }
    const ok = await verifyMfaAuthentication(
      proof.challengeId,
      user.id,
      proof.credential,
    );
    return ok ? { ok } : { ok: false, reason: "bad_assertion" };
  } catch {
    return { ok: false, reason: "bad_assertion" };
  }
}

/**
 * Record a refused proof. The machine reason goes to the audit row and the
 * wide event; the wire carries none of it.
 */
export async function recordReproofFailure(
  userId: string,
  ipAddress: string | null,
  stage: string,
  method: RecentProofMethod,
  reason: string,
): Promise<void> {
  await auditLog("auth.mfa.failed", {
    userId,
    ipAddress,
    details: { stage, method, reason },
  });
  annotate({
    action: { name: "auth.reproof.failed" },
    meta: { stage, method, reason },
  });
}

/** No proof was presented, and the session carries none recent enough. */
export { REPROOF_REQUIRED_CODE };
/** A proof was presented and did not verify. The session is untouched. */
export const REPROOF_FAILED_CODE = "auth.reproof.failed";

/**
 * How recent a sign-in or a second-factor stamp must be to stand in for a
 * proof in the body. The step-up window, so a fresh login is exactly as good
 * here as it is on the fresh-factor routes.
 */
export const RECENT_PROOF_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * The cookie-path gate in front of ADDING a sign-in credential or second
 * factor to an account (TOTP enrollment, security-key enrollment).
 *
 * A live session on its own is not enough. If it were, whoever held a stolen
 * session could enroll their own authenticator, and from then on hold a factor
 * that satisfies every step-up gate, registers a passkey and survives the
 * owner changing the password. So the caller must show that the person at the
 * keyboard can authenticate as the account owner right now.
 *
 * What counts depends on whether the account already has a second factor.
 *
 * Without one (password, passkey or single sign-on only), any of:
 *   - the session completed a passkey sign-in or re-proof within the last five
 *     minutes (`Session.mfaVerifiedAt`);
 *   - the session re-proved a credential at `POST /api/auth/reproof` within
 *     the last five minutes (`Session.reproofAt`);
 *   - the session itself was created by a sign-in within the last five
 *     minutes (`Session.createdAt`, which no later write touches) — this is
 *     also what lets an SSO-only account with nothing else to re-prove enroll
 *     right after signing in;
 *   - the body carries a proof: `{ method: "password", password }`,
 *     `{ method: "totp", code }` or a passkey / security-key assertion, the
 *     same shapes the step-up mint accepts.
 *
 * With one, only a proof of possession of a factor: `Session.mfaVerifiedAt`
 * within five minutes, or a TOTP code, security-key or passkey assertion in
 * the body. A password is not enough and neither is a young session: signing
 * in on a remembered browser skips the second factor and still creates a
 * fresh session, so `createdAt` would let the password alone add a new key,
 * which then satisfies every gate the second factor was protecting.
 *
 * Returns the refusal to send, or null to proceed. Proofs in the body are
 * throttled and audited through the shared re-proof bucket.
 */
export async function checkCookieEnrollmentProof(args: {
  user: ProofUser;
  sessionId: string;
  request: Request;
  ipAddress: string | null;
  stage: string;
}): Promise<Response | null> {
  const { user, sessionId, request, ipAddress, stage } = args;

  const enrolled = await hasSecondFactorEnrolled(user);
  const row = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { mfaVerifiedAt: true, createdAt: true, reproofAt: true },
  });
  const now = Date.now();
  const recent = (d: Date | null | undefined) =>
    d != null && now - d.getTime() <= RECENT_PROOF_MAX_AGE_MS;
  const sessionSatisfies = enrolled
    ? recent(row?.mfaVerifiedAt)
    : recent(row?.mfaVerifiedAt) ||
      recent(row?.createdAt) ||
      recent(row?.reproofAt);
  if (sessionSatisfies) {
    annotate({ meta: { enrollment_proof: "recent_session" } });
    return null;
  }

  const proof = await readProof(request);
  if (proof === "absent") {
    annotate({
      action: { name: "auth.reproof.required" },
      meta: { stage, second_factor: enrolled },
    });
    return apiError("Confirm it is you before adding a sign-in method", 401, {
      errorCode: REPROOF_REQUIRED_CODE,
      methods: await recentProofMethods(user, enrolled),
    });
  }
  if (proof === "invalid") {
    return apiError("Invalid verification", 422, {
      errorCode: REPROOF_REQUIRED_CODE,
    });
  }
  // Refused before a guess is spent: a password that verified would still not
  // open this gate on an account with a second factor.
  if (enrolled && !isSecondFactorProof(proof.method)) {
    annotate({
      action: { name: "auth.reproof.method_refused" },
      meta: { stage, method: proof.method },
    });
    return apiError("Confirm with your second factor or a passkey", 401, {
      errorCode: REPROOF_REQUIRED_CODE,
      methods: await recentProofMethods(user, enrolled),
    });
  }

  const limited = await throttleReproof(user.id, ipAddress, stage);
  if (limited) return limited;

  const outcome = await verifyExistingFactorProof(user, proof);
  if (!outcome.ok) {
    await recordReproofFailure(
      user.id,
      ipAddress,
      stage,
      proof.method,
      outcome.reason,
    );
    return apiError("Verification failed", 401, {
      errorCode: REPROOF_FAILED_CODE,
    });
  }
  await refundReproof(user.id);
  annotate({ meta: { enrollment_proof: proof.method } });
  return null;
}

/**
 * The proofs that stand for possession of a factor rather than knowledge of
 * the password. On an account with a second factor these are the only ones
 * that may add a credential.
 */
export function isSecondFactorProof(
  method: ExistingFactorProof["method"],
): boolean {
  return method === "totp" || method === "webauthn" || method === "passkey";
}

async function readProof(
  request: Request,
): Promise<ExistingFactorProof | "absent" | "invalid"> {
  if (!isJsonContentType(request.headers.get("content-type"))) {
    return "absent";
  }
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return "invalid";
  }
  if (raw.trim() === "") return "absent";
  if (raw.length > 64 * 1024) return "invalid";
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return "invalid";
  }
  if (
    body === null ||
    (typeof body === "object" && Object.keys(body).length === 0)
  ) {
    return "absent";
  }
  const parsed = stepUpMintSchema.safeParse(body);
  return parsed.success ? parsed.data : "invalid";
}

export type SensitiveChangeProof =
  "ok" | "required" | "second_factor_required" | "failed" | "rate_limited";

/**
 * The proof in front of changing the account's email address.
 *
 * The address is what single sign-on matches an existing account by, so it is
 * part of how the account is reached and a stolen session must not rewrite it.
 *
 * On an account WITHOUT a second factor: on a cookie session, a sign-in or
 * re-proof inside the last five minutes; on either transport, the current
 * password alongside the change. The password draws on the shared re-proof
 * budget and a wrong one is audited like every other refused proof.
 *
 * On an account WITH a second factor, the rule `checkCookieEnrollmentProof`
 * holds for adding a credential: only possession of a factor counts, which on
 * a cookie session is `Session.mfaVerifiedAt` inside five minutes (a completed
 * second factor or passkey, at sign-in or at `POST /api/auth/reproof`). The
 * password is not verified at all, and neither a young session nor a password
 * re-proof stands in: a remembered browser skips the factor at sign-in and
 * still creates a fresh session. The answer is `second_factor_required`, so
 * the client opens the re-proof dialog with the factors the account holds. A
 * token carries no such stamp, so a Bearer caller cannot change the address
 * of such an account; the shipped app does not change it.
 */
export async function authorizeSensitiveChange(args: {
  user: ProofUser;
  /** The session row id on a cookie request; null on a Bearer request. */
  cookieSessionId: string | null;
  currentPassword: string | null;
  ipAddress: string | null;
  stage: string;
}): Promise<SensitiveChangeProof> {
  const { user, cookieSessionId, currentPassword, ipAddress, stage } = args;

  const enrolled = await hasSecondFactorEnrolled(user);

  if (cookieSessionId) {
    const row = await prisma.session.findUnique({
      where: { id: cookieSessionId },
      select: { mfaVerifiedAt: true, createdAt: true, reproofAt: true },
    });
    const now = Date.now();
    const recent = (d: Date | null | undefined) =>
      d != null && now - d.getTime() <= RECENT_PROOF_MAX_AGE_MS;
    const satisfied = enrolled
      ? recent(row?.mfaVerifiedAt)
      : recent(row?.mfaVerifiedAt) ||
        recent(row?.createdAt) ||
        recent(row?.reproofAt);
    if (satisfied) return "ok";
  }

  // Before any password is looked at: on this account a right password would
  // not be enough, so checking it would only spend a guess.
  if (enrolled) {
    annotate({
      action: { name: "auth.reproof.method_refused" },
      meta: { stage, method: currentPassword ? "password" : "none" },
    });
    return "second_factor_required";
  }

  if (!currentPassword) return "required";

  const rl = await checkRateLimit(
    reproofBucket(user.id),
    REPROOF_LIMIT,
    REPROOF_WINDOW_MS,
  );
  if (!rl.allowed) {
    await auditLog("auth.reproof.rate_limited", {
      userId: user.id,
      ipAddress,
      details: { stage },
    });
    return "rate_limited";
  }

  const outcome = await verifyExistingFactorProof(user, {
    method: "password",
    password: currentPassword,
  });
  if (!outcome.ok) {
    await recordReproofFailure(
      user.id,
      ipAddress,
      stage,
      "password",
      outcome.reason,
    );
    return "failed";
  }
  await refundReproof(user.id);
  return "ok";
}
