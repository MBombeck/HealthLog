/**
 * The nightly cleanup of the sign-in ledgers (`auth-ledger-cleanup`).
 *
 * A row goes once it has been expired for longer than its grace (30 days for
 * sessions, tokens and trusted devices, a day for challenges). A live row, a
 * recently expired one, a revoked token that has not expired, and a revoked
 * token without an expiry all stay. The delete is batched and says when it
 * stopped with rows left.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { cleanupAuthLedgers } from "@/lib/jobs/auth-ledger-cleanup";

import { getPrismaClient, truncateAllTables } from "./setup";

const USER = "auth-ledger-user";
const NOW = new Date("2026-10-20T03:35:00.000Z");
const DAY = 86_400_000;
const LONG_EXPIRED = new Date(NOW.getTime() - 40 * DAY);
const JUST_EXPIRED = new Date(NOW.getTime() - 10 * DAY);
const LIVE = new Date(NOW.getTime() + 10 * DAY);

const prisma = getPrismaClient();

beforeEach(async () => {
  await truncateAllTables(prisma);
  await prisma.user.create({
    data: { id: USER, username: USER, role: "USER", timezone: "UTC" },
  });
});

async function ids(rows: Promise<Array<{ id: string }>>): Promise<string[]> {
  return (await rows).map((r) => r.id).sort();
}

describe("auth ledger cleanup", () => {
  it("removes rows expired past their grace and keeps everything else", async () => {
    for (const [id, expiresAt] of [
      ["session-old", LONG_EXPIRED],
      ["session-recent", JUST_EXPIRED],
      ["session-live", LIVE],
    ] as const) {
      await prisma.session.create({ data: { id, userId: USER, expiresAt } });
    }
    for (const [id, expiresAt, revokedAt, usedAt] of [
      ["refresh-old", LONG_EXPIRED, null, LONG_EXPIRED],
      ["refresh-recent", JUST_EXPIRED, null, null],
      // Revoked but not yet expired: reuse detection may still need it.
      ["refresh-revoked-live", LIVE, NOW, null],
      ["refresh-used-live", LIVE, null, NOW],
    ] as const) {
      await prisma.refreshToken.create({
        data: {
          id,
          userId: USER,
          tokenHash: `hash-${id}`,
          deviceId: "device-1",
          expiresAt,
          revokedAt,
          usedAt,
        },
      });
    }
    for (const [id, expiresAt, revoked] of [
      ["token-old", LONG_EXPIRED, false],
      ["token-old-revoked", LONG_EXPIRED, true],
      ["token-recent", JUST_EXPIRED, false],
      ["token-live", LIVE, false],
      // No expiry, revoked: nothing says when, so it stays listed.
      ["token-revoked-forever", null, true],
      ["token-forever", null, false],
    ] as const) {
      await prisma.apiToken.create({
        data: {
          id,
          userId: USER,
          name: id,
          tokenHash: `hash-${id}`,
          expiresAt,
          revoked,
        },
      });
    }
    for (const [id, expiresAt] of [
      ["trusted-old", LONG_EXPIRED],
      ["trusted-recent", JUST_EXPIRED],
    ] as const) {
      await prisma.trustedDevice.create({
        data: { id, userId: USER, tokenHash: `hash-${id}`, expiresAt },
      });
    }
    for (const [id, expiresAt] of [
      ["mfa-old", new Date(NOW.getTime() - 2 * DAY)],
      ["mfa-recent", new Date(NOW.getTime() - 60 * 60_000)],
    ] as const) {
      await prisma.mfaChallenge.create({
        data: {
          id,
          userId: USER,
          kind: "totp",
          ticketHash: `hash-${id}`,
          expiresAt,
        },
      });
    }
    for (const [id, expiresAt] of [
      ["challenge-old", new Date(NOW.getTime() - 2 * DAY)],
      ["challenge-recent", new Date(NOW.getTime() - 60 * 60_000)],
    ] as const) {
      await prisma.authChallenge.create({
        data: {
          id,
          userId: null,
          challenge: id,
          type: "registration",
          expiresAt,
        },
      });
    }

    const result = await cleanupAuthLedgers(prisma, NOW);

    expect(result).toEqual({
      deleted: {
        sessions: 1,
        refresh_tokens: 1,
        api_tokens: 2,
        trusted_devices: 1,
        mfa_challenges: 1,
        auth_challenges: 1,
      },
      drained: true,
    });
    expect(
      await ids(prisma.session.findMany({ select: { id: true } })),
    ).toEqual(["session-live", "session-recent"]);
    expect(
      await ids(prisma.refreshToken.findMany({ select: { id: true } })),
    ).toEqual(["refresh-recent", "refresh-revoked-live", "refresh-used-live"]);
    expect(
      await ids(prisma.apiToken.findMany({ select: { id: true } })),
    ).toEqual([
      "token-forever",
      "token-live",
      "token-recent",
      "token-revoked-forever",
    ]);
    expect(
      await ids(prisma.trustedDevice.findMany({ select: { id: true } })),
    ).toEqual(["trusted-recent"]);
    expect(
      await ids(prisma.mfaChallenge.findMany({ select: { id: true } })),
    ).toEqual(["mfa-recent"]);
    expect(
      await ids(prisma.authChallenge.findMany({ select: { id: true } })),
    ).toEqual(["challenge-recent"]);
  });

  it("deletes in batches and reports a table it could not finish", async () => {
    for (let i = 0; i < 5; i++) {
      await prisma.session.create({
        data: { id: `old-${i}`, userId: USER, expiresAt: LONG_EXPIRED },
      });
    }

    const capped = await cleanupAuthLedgers(prisma, NOW, {
      batchSize: 2,
      maxBatches: 2,
    });
    expect(capped.deleted.sessions).toBe(4);
    expect(capped.drained).toBe(false);

    const rest = await cleanupAuthLedgers(prisma, NOW, {
      batchSize: 2,
      maxBatches: 2,
    });
    expect(rest.deleted.sessions).toBe(1);
    expect(rest.drained).toBe(true);
    expect(await prisma.session.count()).toBe(0);
  });
});
