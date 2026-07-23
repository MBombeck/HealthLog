/**
 * Token-bound step-up elevations — the Bearer-transport answer to
 * `Session.mfaVerifiedAt`.
 *
 * WHY THIS EXISTS. Second-factor management (enrol TOTP, confirm it, disable
 * it, rotate recovery codes, add or remove a security key) is gated cookie-only.
 * That gate is correct and stays: a Bearer token is a credential whose
 * provenance the server cannot see — it may have come from an interactive login
 * on the owner's phone, or from a value pasted into a script on a shared
 * machine. Tearing down someone's second factor must not be reachable from the
 * weaker of those two.
 *
 * What was missing was never Bearer ACCESS to those routes. It was a way to
 * express, over a transport that has no session row, "the human holding this
 * device just re-proved a factor". The web writes that as a timestamp on the
 * session; a token client has no session to stamp. An elevation is that proof,
 * made explicit and made disposable.
 *
 * WHICH FACTOR WAS PROVED IS PART OF THE PROOF. `method` is an authorisation
 * input, not telemetry. The web stamps `mfaVerifiedAt` only for a completed
 * SECOND factor (TOTP, security key) or a primary passkey login — never for a
 * password. If a password-proved elevation satisfied the fresh-factor routes,
 * a stolen token plus the account password would rotate the recovery codes
 * (which take no factor in the body) and then spend one of them to disable the
 * second factor outright. So the fresh-factor routes accept only
 * `FRESH_FACTOR_METHODS`, and the password arm reaches exactly what a plain
 * cookie session reaches — no more.
 *
 * THE OTHER PROPERTIES, and why each is load-bearing:
 *
 *   Minted only against a re-proved factor. Presenting the token alone yields
 *   nothing. A stolen token gains no more reach than it had before.
 *
 *   Bound to one token (`apiTokenId`). An elevation minted by the phone cannot
 *   be redeemed by a second token, not even another of the same user's.
 *
 *   Single-use. The claim is one conditional UPDATE, so two concurrent
 *   redemptions cannot both succeed.
 *
 *   Short-lived. `STEP_UP_ELEVATION_TTL_SECONDS` equals the cookie path's
 *   `MFA_STEP_UP_MAX_AGE_SECONDS`, so neither transport is the softer way in.
 *
 *   Stored hashed. Only `hashToken(secret)` reaches the database — the same
 *   posture as ApiToken, RefreshToken, and the session secret.
 *
 * INVALIDATION comes from three directions. A password change (self-service or
 * operator-forced) and a sign-out-everywhere both call
 * `revokeStepUpElevations`. A revoked or deleted token strands its elevations
 * without any code here running: redemption sits behind Bearer resolution,
 * which refuses a revoked token, and the FK cascades on delete.
 */
import { randomBytes } from "node:crypto";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { hashToken } from "@/lib/auth/hmac";

/**
 * Marks a value as a step-up elevation. Distinct from every other credential
 * prefix in the tree (`hlk_` access, `hlr_` refresh, `hls_` session,
 * `hlh_` OIDC handoff) so a value can never be mistaken for the wrong kind.
 */
const ELEVATION_PREFIX = "hle_";
const ELEVATION_SECRET_BYTES = 32;

/**
 * How long an elevation stays redeemable: five minutes.
 *
 * Chosen to equal `MFA_STEP_UP_MAX_AGE_SECONDS`, the window the cookie path has
 * used for step-up since v1.23, rather than picked independently. Two transports
 * guarding the same actions should not offer two different freshness promises —
 * if they diverged, the looser one would simply become the way in. Five minutes
 * also sits at the tight end of the 5–15 minute band OWASP recommends for
 * re-authentication, which is where destructive actions belong.
 *
 * A test pins the two constants together so a future edit to one is caught.
 */
export const STEP_UP_ELEVATION_TTL_SECONDS = 5 * 60;

/**
 * Which factor was re-proved. This is an AUTHORISATION INPUT — see
 * `FRESH_FACTOR_METHODS` and the file header.
 *
 *   password — the account password. Reaches what a plain cookie session
 *              reaches, and no further.
 *   totp     — a current code from the enrolled authenticator.
 *   webauthn — an assertion from a registered second-factor security key.
 *   passkey  — an assertion from a primary passkey. At parity with
 *              `/api/auth/passkey/login-verify`, which stamps `mfaVerifiedAt`
 *              on the web for the very same ceremony.
 */
export type StepUpMethod = "password" | "totp" | "webauthn" | "passkey";

/**
 * The methods that satisfy a fresh-factor gate — exactly the set for which the
 * web writes `mfaVerifiedAt`. `password` is deliberately absent: a password
 * login has never satisfied step-up on the web and must not start here.
 *
 * A recovery code is also absent, and that IS a narrowing relative to the web,
 * where `/api/auth/mfa/verify` accepts one and does stamp the session. The
 * consequence is that an account which has lost its authenticator cannot
 * disable its second factor from the app — only from the web. That asymmetry is
 * deliberate and flagged rather than quietly closed, because admitting a
 * recovery code here means spending one break-glass credential to authorise
 * spending another.
 */
export const FRESH_FACTOR_METHODS: ReadonlySet<StepUpMethod> = new Set([
  "totp",
  "webauthn",
  "passkey",
]);

export function isFreshFactorMethod(method: StepUpMethod): boolean {
  return FRESH_FACTOR_METHODS.has(method);
}

export interface MintedElevation {
  /** The raw `hle_<64 hex>` value. Returned once; never persisted, never logged. */
  token: string;
  expiresAt: Date;
}

/**
 * Mint an elevation for `(userId, apiTokenId)` after a factor has been re-proved.
 *
 * The caller is responsible for having verified the factor — this function does
 * not check anything, it records a decision already made. Keep the two adjacent
 * so that stays obvious.
 *
 * The delete-then-create runs in ONE transaction. Without it two concurrent
 * mints can interleave so the second's delete removes the first's row after the
 * first has already handed its value to the client, leaving a caller holding an
 * elevation that can never redeem. The partial unique index from migration 0260
 * is the backstop: if two transactions still collide, one loses on the
 * constraint and retries rather than both rows surviving.
 */
export async function mintStepUpElevation(opts: {
  userId: string;
  apiTokenId: string;
  method: StepUpMethod;
}): Promise<MintedElevation> {
  const raw = `${ELEVATION_PREFIX}${randomBytes(ELEVATION_SECRET_BYTES).toString("hex")}`;
  const expiresAt = new Date(Date.now() + STEP_UP_ELEVATION_TTL_SECONDS * 1000);

  const write = async () =>
    prisma.$transaction(async (tx) => {
      // A fresh proof supersedes an older one, so there is never more than one
      // redeemable elevation per token. That bounds the table and shrinks the
      // window in which a captured elevation is worth anything.
      await tx.stepUpElevation.deleteMany({
        where: { apiTokenId: opts.apiTokenId, consumedAt: null },
      });
      await tx.stepUpElevation.create({
        data: {
          userId: opts.userId,
          apiTokenId: opts.apiTokenId,
          tokenHash: hashToken(raw),
          method: opts.method,
          expiresAt,
        },
        select: { id: true },
      });
    });

  try {
    await write();
  } catch (err) {
    // P2002 on the partial index: a concurrent mint won the race between our
    // delete and our insert. One retry (whose delete removes that winner in
    // turn) resolves it deterministically.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      await write();
    } else {
      throw err;
    }
  }

  return { token: raw, expiresAt };
}

/** Why an elevation was refused. Audit detail only — never surfaced to a caller. */
export type StepUpRejection =
  | "malformed"
  | "unknown"
  | "wrong_token"
  | "consumed"
  | "expired"
  | "insufficient_factor";

export type StepUpOutcome =
  { ok: true; method: StepUpMethod } | { ok: false; reason: StepUpRejection };

/**
 * Check an elevation WITHOUT consuming it.
 *
 * Split from the claim so a route can refuse a bad request — a 429, a malformed
 * body, a wrong TOTP code — without burning the caller's elevation. Burning one
 * on a validation failure was a self-inflicted lockout: the mint allows five
 * attempts per fifteen minutes, so five fat-fingered codes would lock a user out
 * of their own second-factor settings.
 *
 * This is NOT an authorisation decision on its own, and nothing may mutate on
 * the strength of it. `claimStepUpElevation` still has to win the race before
 * any effect happens; this only decides whether the request is worth processing.
 */
export async function validateStepUpElevation(opts: {
  rawToken: string;
  userId: string;
  apiTokenId: string;
  requireFreshFactor: boolean;
}): Promise<StepUpOutcome> {
  if (!opts.rawToken.startsWith(ELEVATION_PREFIX)) {
    return { ok: false, reason: "malformed" };
  }

  const row = await prisma.stepUpElevation.findUnique({
    where: { tokenHash: hashToken(opts.rawToken) },
    select: {
      userId: true,
      apiTokenId: true,
      consumedAt: true,
      expiresAt: true,
      method: true,
    },
  });

  if (!row) return { ok: false, reason: "unknown" };
  if (row.userId !== opts.userId || row.apiTokenId !== opts.apiTokenId) {
    return { ok: false, reason: "wrong_token" };
  }
  if (row.consumedAt) return { ok: false, reason: "consumed" };
  if (row.expiresAt <= new Date()) return { ok: false, reason: "expired" };

  const method = row.method as StepUpMethod;
  if (opts.requireFreshFactor && !isFreshFactorMethod(method)) {
    return { ok: false, reason: "insufficient_factor" };
  }

  return { ok: true, method };
}

/**
 * Consume an elevation, or refuse.
 *
 * SINGLE-USE ATOMICITY. The claim is one conditional `UPDATE … WHERE
 * token_hash = $1 AND user_id = $2 AND api_token_id = $3 AND consumed_at IS NULL
 * AND expires_at > $4 RETURNING method`, and the caller proceeds only on exactly
 * one returned row. Postgres under READ COMMITTED serialises the two writers on
 * the row lock: the loser re-evaluates the predicate against the winner's
 * committed version, finds `consumed_at` no longer null, and returns nothing.
 * There is no read-then-write window to lose, which is why the check-then-update
 * shape was not used.
 *
 * `RETURNING method` rather than a follow-up SELECT: a separate read can miss,
 * and any fallback for that miss would fabricate an authorisation-relevant
 * value — logging a passkey-proved elevation as password-proved, or worse,
 * deciding a gate on the invented one. The statement that decides is the
 * statement that reports.
 *
 * The fresh-factor rule is enforced here, on the returned row, not only in
 * `validateStepUpElevation`. That validation is advisory; this is the gate. When
 * the method is insufficient the row stays consumed — it was a real elevation
 * presented in a real redemption, so spending it is right.
 */
export async function claimStepUpElevation(opts: {
  rawToken: string;
  userId: string;
  apiTokenId: string;
  requireFreshFactor: boolean;
}): Promise<StepUpOutcome> {
  if (!opts.rawToken.startsWith(ELEVATION_PREFIX)) {
    return { ok: false, reason: "malformed" };
  }

  const tokenHash = hashToken(opts.rawToken);
  const now = new Date();

  const claimed = await prisma.$queryRaw<{ method: string }[]>`
    UPDATE step_up_elevations
       SET consumed_at = ${now}
     WHERE token_hash = ${tokenHash}
       AND user_id = ${opts.userId}
       AND api_token_id = ${opts.apiTokenId}
       AND consumed_at IS NULL
       AND expires_at > ${now}
    RETURNING method
  `;

  if (claimed.length !== 1) {
    // Classify for the audit row only. The caller returns one generic response
    // for every branch, so this tells an operator what happened without telling
    // a prober anything.
    const existing = await prisma.stepUpElevation.findUnique({
      where: { tokenHash },
      select: { userId: true, apiTokenId: true, consumedAt: true },
    });
    if (!existing) return { ok: false, reason: "unknown" };
    if (
      existing.userId !== opts.userId ||
      existing.apiTokenId !== opts.apiTokenId
    ) {
      return { ok: false, reason: "wrong_token" };
    }
    if (existing.consumedAt) return { ok: false, reason: "consumed" };
    return { ok: false, reason: "expired" };
  }

  const method = claimed[0].method as StepUpMethod;
  if (opts.requireFreshFactor && !isFreshFactorMethod(method)) {
    return { ok: false, reason: "insufficient_factor" };
  }

  return { ok: true, method };
}

/**
 * Drop every elevation for a user.
 *
 * Called when the account password changes (self-service or operator-forced)
 * and on sign-out-everywhere. An elevation is a statement about a credential and
 * a moment, and neither survives either of those events. Deliberately
 * unconditional over the user's rows — consumed ones go too, since there is no
 * reason to keep them once the anchor moved.
 */
export async function revokeStepUpElevations(userId: string): Promise<void> {
  await prisma.stepUpElevation.deleteMany({ where: { userId } });
}

// The expired-elevation sweep runs on the pg-boss queue against the WORKER
// Prisma client, not this module's request-scoped one — see
// `handleStepUpElevationCleanup` in `@/lib/jobs/reminder/cleanup-handlers`.
// A copy of the predicate here would be unreachable and only invite drift
// between the two, so it does not exist.
