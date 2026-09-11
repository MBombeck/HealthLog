/**
 * The email-address conflict answer is metered, and metered before it answers.
 *
 * `applyProfileUpdate` is the one place both profile routes reach, and its
 * 409 tells any signed-in caller whether a given address belongs to an
 * account on this instance. Until this bucket existed neither route had a
 * ceiling of any kind — `apiHandler` supplies none — so one account could
 * walk an address book at whatever rate the network allowed.
 *
 * What is pinned here. The charge happens BEFORE the uniqueness probe, so a
 * refused request never learns the answer it was refused for. A save that
 * carries the address already on file is not charged at all, so a settings
 * form that re-posts the whole profile does not spend an honest afternoon of
 * edits on the ceiling. A refusal drops the address and keeps the rest of the
 * save, so one spent budget cannot block somebody setting their timezone; the
 * published 429 is for the request that asked for nothing else. And both
 * answers worth detecting leave an audit row, because neither reaches the
 * ordinary `profile.update` row written after the save.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn(), update: vi.fn() },
  },
}));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkProfileEmailRateLimit: vi.fn(),
}));

import { applyProfileUpdate } from "../profile-update";
import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import { checkProfileEmailRateLimit } from "@/lib/rate-limit";

const USER_ID = "user-1";
const ON_FILE = "mine@example.test";

/** The `where` clauses the helper can send, told apart by their shape. */
function selfLookups() {
  return vi
    .mocked(prisma.user.findUnique)
    .mock.calls.filter((c) => "id" in (c[0]!.where as object));
}
function emailProbes() {
  return vi
    .mocked(prisma.user.findUnique)
    .mock.calls.filter((c) => "email" in (c[0]!.where as object));
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(prisma.user.update).mockResolvedValue({
    id: USER_ID,
    username: "u",
    email: ON_FILE,
  } as never);
  vi.mocked(checkProfileEmailRateLimit).mockResolvedValue({
    allowed: true,
    limit: 10,
    remaining: 9,
    resetAt: Date.now() + 3_600_000,
  });
  vi.mocked(prisma.user.findUnique).mockImplementation((async (args: {
    where: Record<string, unknown>;
  }) => {
    if ("id" in args.where) return { email: ON_FILE };
    return null;
  }) as never);
});

describe("applyProfileUpdate — the email conflict is metered", () => {
  it("charges the acting account before asking about the address", async () => {
    await applyProfileUpdate(USER_ID, { email: "someone@example.test" });

    expect(checkProfileEmailRateLimit).toHaveBeenCalledWith(USER_ID);
    expect(emailProbes()).toHaveLength(1);
    // Ordering, not just presence: the probe must not have run first.
    const chargedAt = vi.mocked(checkProfileEmailRateLimit).mock
      .invocationCallOrder[0];
    const probedAt = vi.mocked(prisma.user.findUnique).mock.invocationCallOrder[
      selfLookups().length
    ];
    expect(chargedAt).toBeLessThan(probedAt);
  });

  it("refuses with 429 and the published code when the address was all that was asked for", async () => {
    vi.mocked(checkProfileEmailRateLimit).mockResolvedValue({
      allowed: false,
      limit: 10,
      remaining: 0,
      resetAt: Date.now() + 3_600_000,
    });

    const result = await applyProfileUpdate(USER_ID, {
      email: "someone@example.test",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(429);
      expect(result.errorCode).toBe("profile.update.emailRateLimited");
    }
    // The whole point: a refused caller is told nothing about the address.
    expect(emailProbes()).toHaveLength(0);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("does not charge a save that carries the address already on file", async () => {
    const result = await applyProfileUpdate(USER_ID, {
      // Same address, differently typed — normalisation is what decides.
      email: " Mine@Example.Test ",
      heightCm: 180,
    });

    expect(result.ok).toBe(true);
    expect(checkProfileEmailRateLimit).not.toHaveBeenCalled();
    expect(emailProbes()).toHaveLength(0);
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
  });

  it("does not charge an update that never touches the address", async () => {
    await applyProfileUpdate(USER_ID, { heightCm: 181 });

    expect(checkProfileEmailRateLimit).not.toHaveBeenCalled();
  });

  it("keeps the rest of the save when the budget is spent, dropping only the address", async () => {
    // The web form posts the whole profile in one request. Failing all of it
    // would stop somebody setting their timezone for an hour and tell them it
    // was about email addresses.
    vi.mocked(checkProfileEmailRateLimit).mockResolvedValue({
      allowed: false,
      limit: 10,
      remaining: 0,
      resetAt: Date.now() + 3_600_000,
    });

    const result = await applyProfileUpdate(USER_ID, {
      email: "someone@example.test",
      timezone: "Europe/Lisbon",
      heightCm: 180,
    });

    expect(result.ok).toBe(true);
    const written = vi.mocked(prisma.user.update).mock.calls[0]![0]!
      .data as Record<string, unknown>;
    expect(Object.keys(written).sort()).toEqual(["heightCm", "timezone"]);
    expect("email" in written).toBe(false);
    if (result.ok) {
      expect(result.rejectedFields).toEqual([
        expect.objectContaining({ path: "email", code: "rate_limited" }),
      ]);
    }
    // Still no probe: the refused caller learns nothing about the address.
    expect(emailProbes()).toHaveLength(0);
  });

  it("records both answers worth detecting in the audit ledger", async () => {
    vi.mocked(checkProfileEmailRateLimit).mockResolvedValue({
      allowed: false,
      limit: 10,
      remaining: 0,
      resetAt: Date.now() + 3_600_000,
    });
    await applyProfileUpdate(USER_ID, { email: "someone@example.test" });
    expect(auditLog).toHaveBeenCalledWith(
      "profile.email.rate_limited",
      expect.objectContaining({ userId: USER_ID }),
    );

    vi.mocked(auditLog).mockClear();
    vi.mocked(checkProfileEmailRateLimit).mockResolvedValue({
      allowed: true,
      limit: 10,
      remaining: 9,
      resetAt: Date.now() + 3_600_000,
    });
    vi.mocked(prisma.user.findUnique).mockImplementation((async (args: {
      where: Record<string, unknown>;
    }) => {
      if ("id" in args.where) return { email: ON_FILE };
      return { id: "someone-else" };
    }) as never);

    await applyProfileUpdate(USER_ID, { email: "taken@example.test" });
    expect(auditLog).toHaveBeenCalledWith(
      "profile.email.conflict",
      expect.objectContaining({ userId: USER_ID }),
    );
    // Neither path reaches the ordinary post-save row.
    expect(auditLog).not.toHaveBeenCalledWith(
      "profile.update",
      expect.anything(),
    );
  });

  it("does not charge an account whose stored address is spelled differently", async () => {
    // Registration writes the address as typed, so an account created as
    // `Mine@Example.Test` has that in the column. Comparing it raw against
    // the normalised submission would charge its first ordinary save.
    vi.mocked(prisma.user.findUnique).mockImplementation((async (args: {
      where: Record<string, unknown>;
    }) => {
      if ("id" in args.where) return { email: "Mine@Example.Test" };
      return null;
    }) as never);

    const result = await applyProfileUpdate(USER_ID, { email: ON_FILE });

    expect(result.ok).toBe(true);
    expect(checkProfileEmailRateLimit).not.toHaveBeenCalled();
    expect(emailProbes()).toHaveLength(0);
  });

  it("still answers 409 when the bucket has room and the address is taken", async () => {
    vi.mocked(prisma.user.findUnique).mockImplementation((async (args: {
      where: Record<string, unknown>;
    }) => {
      if ("id" in args.where) return { email: ON_FILE };
      return { id: "someone-else" };
    }) as never);

    const result = await applyProfileUpdate(USER_ID, {
      email: "taken@example.test",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(409);
      expect(result.errorCode).toBe("profile.update.emailInUse");
    }
    expect(checkProfileEmailRateLimit).toHaveBeenCalledTimes(1);
  });
});
