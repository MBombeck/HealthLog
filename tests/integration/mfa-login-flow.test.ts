/**
 * Integration guard for the second-factor login path against real Postgres.
 *
 * Unit tests mock Prisma, so they cannot prove the security-critical DB-backed
 * invariants: that a verified TOTP step is actually persisted (replay guard),
 * that the recovery-code burn is durable and one-time, and that the challenge
 * ticket can be claimed exactly once. This exercises all three end to end.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as OTPAuth from "otpauth";

import { getPrismaClient, truncateAllTables } from "./setup";

// hashToken (challenge ticket hashing) is fail-closed on a weak/absent key.
process.env.API_TOKEN_HMAC_KEY ??=
  "test-hmac-key-test-hmac-key-test-hmac-key-0123456789";

function codeAt(secretBase32: string, atMs: number): string {
  const totp = new OTPAuth.TOTP({
    issuer: "HealthLog",
    label: "HealthLog",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  });
  return totp.generate({ timestamp: atMs });
}

let secret: string;
let encrypt: (s: string) => string;

beforeAll(async () => {
  ({ encrypt } = await import("@/lib/crypto"));
  const { generateTotpSecret } = await import("@/lib/auth/mfa/totp");
  secret = generateTotpSecret();
});

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
});

describe("MFA login flow (real Postgres)", () => {
  it("TOTP verify persists the step and rejects a replay", async () => {
    const { verifyMfaFactor } = await import("@/lib/auth/mfa/verify-factor");
    const prisma = getPrismaClient();

    const user = await prisma.user.create({
      data: {
        username: "totp-user",
        email: "totp@example.test",
        totpSecretEncrypted: encrypt(secret),
        totpConfirmedAt: new Date(),
      },
    });

    // verifyMfaFactor verifies against the real wall clock, so the code must
    // be generated for "now".
    const code = codeAt(secret, Date.now());

    const first = await verifyMfaFactor(
      {
        id: user.id,
        totpSecretEncrypted: encrypt(secret),
        totpLastStep: null,
        totpConfirmedAt: user.totpConfirmedAt,
      },
      "totp",
      code,
    );
    expect(first.ok).toBe(true);

    const afterFirst = await prisma.user.findUnique({
      where: { id: user.id },
      select: { totpLastStep: true },
    });
    expect(afterFirst?.totpLastStep).not.toBeNull();

    // Replay the same code — the persisted step now floors it out.
    const replay = await verifyMfaFactor(
      {
        id: user.id,
        totpSecretEncrypted: encrypt(secret),
        totpLastStep: afterFirst?.totpLastStep ?? null,
        totpConfirmedAt: user.totpConfirmedAt,
      },
      "totp",
      code,
    );
    expect(replay.ok).toBe(false);
    expect(replay.replay).toBe(true);
  });

  it("challenge is single-use and burns at the attempt cap", async () => {
    const {
      createMfaChallenge,
      loadActiveChallenge,
      claimChallenge,
      reserveChallengeAttempt,
      recordChallengeFailure,
      MFA_CHALLENGE_ATTEMPT_CAP,
    } = await import("@/lib/auth/mfa/challenge");
    const prisma = getPrismaClient();

    const user = await prisma.user.create({
      data: { username: "ch-user", email: "ch@example.test" },
    });

    const { ticket } = await createMfaChallenge(user.id, "login");
    const active = await loadActiveChallenge(ticket);
    expect(active).not.toBeNull();

    // Claim-once: first claim wins, second loses, ticket no longer loadable.
    expect(await claimChallenge(active!.id)).toBe(true);
    expect(await claimChallenge(active!.id)).toBe(false);
    expect(await loadActiveChallenge(ticket)).toBeNull();

    // Attempt cap burns a fresh ticket.
    const second = await createMfaChallenge(user.id, "login");
    const row = await loadActiveChallenge(second.ticket);
    let exhausted = false;
    for (let i = 0; i < MFA_CHALLENGE_ATTEMPT_CAP; i++) {
      expect(await reserveChallengeAttempt(row!.id)).toBe(true);
      ({ exhausted } = await recordChallengeFailure(row!.id));
    }
    expect(exhausted).toBe(true);
    expect(await loadActiveChallenge(second.ticket)).toBeNull();
    expect(await reserveChallengeAttempt(row!.id)).toBe(false);
  });

  it("concurrent guesses cannot exceed the attempt cap", async () => {
    const {
      createMfaChallenge,
      loadActiveChallenge,
      reserveChallengeAttempt,
      MFA_CHALLENGE_ATTEMPT_CAP,
    } = await import("@/lib/auth/mfa/challenge");
    const prisma = getPrismaClient();
    const user = await prisma.user.create({
      data: { username: "race-user", email: "race@example.test" },
    });
    const { ticket } = await createMfaChallenge(user.id, "login");
    const active = await loadActiveChallenge(ticket);

    // Every request read "0 attempts" under the old read-then-increment; fire
    // four times the cap at once and count how many were allowed to guess.
    const results = await Promise.all(
      Array.from({ length: MFA_CHALLENGE_ATTEMPT_CAP * 4 }, () =>
        reserveChallengeAttempt(active!.id),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(MFA_CHALLENGE_ATTEMPT_CAP);
    const row = await prisma.mfaChallenge.findUnique({
      where: { id: active!.id },
      select: { attempts: true },
    });
    expect(row?.attempts).toBe(MFA_CHALLENGE_ATTEMPT_CAP);
  });

  it("recovery code is one-time-use and regeneration invalidates the set", async () => {
    const {
      generateRecoveryCodes,
      persistRecoveryCodes,
      verifyAndConsumeRecoveryCode,
      countRemainingRecoveryCodes,
      regenerateRecoveryCodes,
    } = await import("@/lib/auth/mfa/recovery-codes");
    const prisma = getPrismaClient();

    const user = await prisma.user.create({
      data: { username: "rec-user", email: "rec@example.test" },
    });

    const codes = generateRecoveryCodes();
    await persistRecoveryCodes(prisma, user.id, codes);
    expect(await countRemainingRecoveryCodes(user.id)).toBe(codes.length);

    // First use succeeds, second use of the same code fails.
    expect(await verifyAndConsumeRecoveryCode(user.id, codes[0])).toBe(true);
    expect(await verifyAndConsumeRecoveryCode(user.id, codes[0])).toBe(false);
    expect(await countRemainingRecoveryCodes(user.id)).toBe(codes.length - 1);

    // Regeneration drops every prior code (including the one not yet used).
    const fresh = await regenerateRecoveryCodes(user.id);
    expect(await countRemainingRecoveryCodes(user.id)).toBe(fresh.length);
    expect(await verifyAndConsumeRecoveryCode(user.id, codes[1])).toBe(false);
    expect(await verifyAndConsumeRecoveryCode(user.id, fresh[0])).toBe(true);
  });
});
