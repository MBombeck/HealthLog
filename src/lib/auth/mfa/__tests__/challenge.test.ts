import { describe, it, expect, vi, beforeEach } from "vitest";

/** The account row the pending-deletion check reads. */
const accountRow = vi.hoisted(() => ({
  current: {
    deletionRequestedAt: null as Date | null,
    deletionPurgeAt: null as Date | null,
  },
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    mfaChallenge: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    user: { findUnique: vi.fn(async () => accountRow.current) },
  },
}));

// Stand-in for the real HMAC: deterministic but NOT containing the raw
// ticket, so the "raw ticket is never persisted" assertion is meaningful.
vi.mock("@/lib/auth/hmac", () => ({
  hashToken: vi.fn((t: string) => `H${t.length}`),
}));

import {
  createMfaChallenge,
  loadActiveChallenge,
  recordChallengeFailure,
  reserveChallengeAttempt,
  claimChallenge,
  MFA_CHALLENGE_ATTEMPT_CAP,
} from "../challenge";
import { prisma } from "@/lib/db";

beforeEach(() => {
  vi.clearAllMocks();
  accountRow.current = { deletionRequestedAt: null, deletionPurgeAt: null };
});

function activeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "ch-1",
    userId: "user-1",
    kind: "login",
    attempts: 0,
    expiresAt: new Date(Date.now() + 60_000),
    consumedAt: null,
    ...overrides,
  };
}

describe("mfa challenge", () => {
  it("mints a ticket and stores only its hash", async () => {
    vi.mocked(prisma.mfaChallenge.create).mockResolvedValue({} as never);
    const { ticket } = await createMfaChallenge("user-1", "login");
    expect(typeof ticket).toBe("string");
    expect(ticket.length).toBeGreaterThan(20);
    const arg = vi.mocked(prisma.mfaChallenge.create).mock.calls[0][0];
    expect(arg.data.ticketHash).toBe(`H${ticket.length}`);
    // Raw ticket is never persisted.
    expect(JSON.stringify(arg)).not.toContain(ticket);
  });

  it("asks no second factor of an account pending deletion", async () => {
    const purgeAt = new Date("2026-11-08T10:00:00.000Z");
    accountRow.current = {
      deletionRequestedAt: new Date("2026-10-25T10:00:00.000Z"),
      deletionPurgeAt: purgeAt,
    };
    await expect(createMfaChallenge("user-1", "login")).rejects.toMatchObject({
      statusCode: 403,
      errorCode: "auth.account.deletion_pending",
      extraMeta: { purgeAt: purgeAt.toISOString() },
    });
    expect(prisma.mfaChallenge.create).not.toHaveBeenCalled();
  });

  it("loads an active challenge by hash", async () => {
    vi.mocked(prisma.mfaChallenge.findUnique).mockResolvedValue(
      activeRow() as never,
    );
    const res = await loadActiveChallenge("tkt");
    expect(res?.id).toBe("ch-1");
    expect(
      vi.mocked(prisma.mfaChallenge.findUnique).mock.calls[0][0],
    ).toMatchObject({ where: { ticketHash: "H3" } });
  });

  it("refuses a consumed ticket (single-use)", async () => {
    vi.mocked(prisma.mfaChallenge.findUnique).mockResolvedValue(
      activeRow({ consumedAt: new Date() }) as never,
    );
    expect(await loadActiveChallenge("tkt")).toBeNull();
  });

  it("refuses an expired ticket (TTL)", async () => {
    vi.mocked(prisma.mfaChallenge.findUnique).mockResolvedValue(
      activeRow({ expiresAt: new Date(Date.now() - 1000) }) as never,
    );
    expect(await loadActiveChallenge("tkt")).toBeNull();
  });

  it("refuses a ticket at the attempt cap", async () => {
    vi.mocked(prisma.mfaChallenge.findUnique).mockResolvedValue(
      activeRow({ attempts: MFA_CHALLENGE_ATTEMPT_CAP }) as never,
    );
    expect(await loadActiveChallenge("tkt")).toBeNull();
  });

  it("refuses an unknown ticket", async () => {
    vi.mocked(prisma.mfaChallenge.findUnique).mockResolvedValue(null as never);
    expect(await loadActiveChallenge("nope")).toBeNull();
  });

  it("reserves an attempt with one guarded update bounded by the cap", async () => {
    vi.mocked(prisma.mfaChallenge.updateMany).mockResolvedValue({
      count: 1,
    } as never);
    expect(await reserveChallengeAttempt("ch-1")).toBe(true);
    expect(prisma.mfaChallenge.updateMany).toHaveBeenCalledWith({
      where: {
        id: "ch-1",
        consumedAt: null,
        attempts: { lt: MFA_CHALLENGE_ATTEMPT_CAP },
        expiresAt: { gt: expect.any(Date) },
      },
      data: { attempts: { increment: 1 } },
    });
    // No separate read decides the cap — the WHERE is the whole check.
    expect(prisma.mfaChallenge.findUnique).not.toHaveBeenCalled();
  });

  it("refuses the reservation once the guarded update matches nothing", async () => {
    vi.mocked(prisma.mfaChallenge.updateMany).mockResolvedValue({
      count: 0,
    } as never);
    expect(await reserveChallengeAttempt("ch-1")).toBe(false);
  });

  it("settling a failure does not count the attempt a second time", async () => {
    vi.mocked(prisma.mfaChallenge.findUnique).mockResolvedValue({
      attempts: 2,
    } as never);
    await recordChallengeFailure("ch-1");
    expect(prisma.mfaChallenge.update).not.toHaveBeenCalled();
  });

  it("burns the ticket when the attempt cap is reached", async () => {
    vi.mocked(prisma.mfaChallenge.findUnique).mockResolvedValue({
      attempts: MFA_CHALLENGE_ATTEMPT_CAP,
    } as never);
    vi.mocked(prisma.mfaChallenge.updateMany).mockResolvedValue({
      count: 1,
    } as never);
    const res = await recordChallengeFailure("ch-1");
    expect(res.exhausted).toBe(true);
    // Burn sets consumedAt only while still null (claim-once guard).
    expect(prisma.mfaChallenge.updateMany).toHaveBeenCalledWith({
      where: { id: "ch-1", consumedAt: null },
      data: { consumedAt: expect.any(Date) },
    });
  });

  it("does not burn below the attempt cap", async () => {
    vi.mocked(prisma.mfaChallenge.findUnique).mockResolvedValue({
      attempts: 1,
    } as never);
    const res = await recordChallengeFailure("ch-1");
    expect(res.exhausted).toBe(false);
    expect(prisma.mfaChallenge.updateMany).not.toHaveBeenCalled();
  });

  it("claim-once: only the winning update returns true", async () => {
    vi.mocked(prisma.mfaChallenge.updateMany).mockResolvedValueOnce({
      count: 1,
    } as never);
    expect(await claimChallenge("ch-1")).toBe(true);

    vi.mocked(prisma.mfaChallenge.updateMany).mockResolvedValueOnce({
      count: 0,
    } as never);
    expect(await claimChallenge("ch-1")).toBe(false);
  });
});
