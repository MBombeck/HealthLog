/**
 * MfaChallenge — the short-lived, single-use login step-up ticket.
 *
 * When a password (or other primary credential) is accepted for an account
 * that has a second factor enabled, **no session or token is issued**.
 * Instead a challenge row is minted: the partial "password OK, awaiting
 * factor 2" state lives entirely in this row, never in a half-built
 * `Session`. The caller receives an opaque ticket; only its hash
 * (`hashToken`) is stored, so a leaked database row cannot reconstruct a
 * usable ticket.
 *
 * Guarantees enforced here:
 * - **TTL** (~5 min) — `expiresAt`; an expired ticket is never loadable.
 * - **Attempt cap** — every verification first RESERVES an attempt with one
 *   guarded UPDATE (`attempts < cap` in the WHERE), so the cap bounds the
 *   number of guesses even when they arrive concurrently. It used to be a
 *   read, a verification, then an increment: parallel requests all read the
 *   same count below the cap and every one of them got to guess. A failed
 *   verification then burns the ticket (`consumedAt` set) once the cap is
 *   hit, forcing a fresh password login (NIST throttle, not an account lock).
 * - **Claim-once** — consuming a ticket is an atomic guarded update
 *   (`consumedAt: null` in the WHERE), so two concurrent verifications can
 *   never both succeed and mint two sessions. The factor is verified first;
 *   the session is issued only after the claim wins.
 */
import { randomBytes } from "node:crypto";
import { hashToken } from "@/lib/auth/hmac";
import { prisma } from "@/lib/db";
import { assertAccountNotPendingDeletion } from "@/lib/account-deletion/pending";

/** Login step-up: the only `kind` Phase M exercises. */
export type MfaChallengeKind = "login";

/** 5-minute ticket life — long enough to read a code, short enough to bound replay. */
export const MFA_CHALLENGE_TTL_MS = 5 * 60 * 1000;
/** Wrong-factor attempts before the ticket is burned. */
export const MFA_CHALLENGE_ATTEMPT_CAP = 5;

export interface CreatedChallenge {
  /** The opaque ticket handed to the client (never stored in the clear). */
  ticket: string;
  expiresAt: Date;
}

/** Mint a fresh single-use challenge for a user/kind. */
export async function createMfaChallenge(
  userId: string,
  kind: MfaChallengeKind,
): Promise<CreatedChallenge> {
  // No second factor is asked of an account pending deletion: the caller has
  // proved the first one, so the refusal may name the date (403
  // `auth.account.deletion_pending`) instead of costing them a code.
  await assertAccountNotPendingDeletion(userId);
  const ticket = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + MFA_CHALLENGE_TTL_MS);
  await prisma.mfaChallenge.create({
    data: {
      userId,
      kind,
      ticketHash: hashToken(ticket),
      expiresAt,
    },
  });
  return { ticket, expiresAt };
}

export interface ActiveChallenge {
  id: string;
  userId: string;
  kind: string;
  attempts: number;
  expiresAt: Date;
}

/**
 * Resolve a presented ticket to its live challenge, or null when it is
 * unknown / already consumed / expired / over the attempt cap. The lookup
 * is by hash — the raw ticket is never compared against a stored plaintext.
 */
export async function loadActiveChallenge(
  ticket: string,
): Promise<ActiveChallenge | null> {
  const row = await prisma.mfaChallenge.findUnique({
    where: { ticketHash: hashToken(ticket) },
    select: {
      id: true,
      userId: true,
      kind: true,
      attempts: true,
      expiresAt: true,
      consumedAt: true,
    },
  });
  if (!row) return null;
  if (row.consumedAt !== null) return null;
  if (row.expiresAt.getTime() <= Date.now()) return null;
  if (row.attempts >= MFA_CHALLENGE_ATTEMPT_CAP) return null;
  return {
    id: row.id,
    userId: row.userId,
    kind: row.kind,
    attempts: row.attempts,
    expiresAt: row.expiresAt,
  };
}

/**
 * Reserve one verification attempt against the ticket. Must run BEFORE the
 * factor is checked. The increment and the cap check are one conditional
 * UPDATE, so of any number of concurrent callers at most
 * `MFA_CHALLENGE_ATTEMPT_CAP` in total ever get `true`. A `false` means the
 * ticket is spent, expired or out of attempts, and the caller answers with the
 * same generic refusal as an unknown ticket.
 */
export async function reserveChallengeAttempt(
  challengeId: string,
): Promise<boolean> {
  const reserved = await prisma.mfaChallenge.updateMany({
    where: {
      id: challengeId,
      consumedAt: null,
      attempts: { lt: MFA_CHALLENGE_ATTEMPT_CAP },
      expiresAt: { gt: new Date() },
    },
    data: { attempts: { increment: 1 } },
  });
  return reserved.count === 1;
}

/**
 * Settle a failed attempt that `reserveChallengeAttempt` already counted.
 * Does not increment again; when the reserved count has reached the cap the
 * ticket is burned (`consumedAt` set) so it cannot be retried. Returns whether
 * the ticket is now exhausted.
 */
export async function recordChallengeFailure(
  challengeId: string,
): Promise<{ exhausted: boolean; attempts: number }> {
  const row = await prisma.mfaChallenge.findUnique({
    where: { id: challengeId },
    select: { attempts: true },
  });
  const attempts = row?.attempts ?? MFA_CHALLENGE_ATTEMPT_CAP;
  const exhausted = attempts >= MFA_CHALLENGE_ATTEMPT_CAP;
  if (exhausted) {
    await prisma.mfaChallenge.updateMany({
      where: { id: challengeId, consumedAt: null },
      data: { consumedAt: new Date() },
    });
  }
  return { exhausted, attempts };
}

/**
 * Atomically claim the ticket. Returns true only for the single caller that
 * transitions `consumedAt` from null → now. The factor MUST already be
 * verified before this is called; the session is issued only when this
 * returns true.
 */
export async function claimChallenge(challengeId: string): Promise<boolean> {
  const claimed = await prisma.mfaChallenge.updateMany({
    where: { id: challengeId, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  return claimed.count === 1;
}
