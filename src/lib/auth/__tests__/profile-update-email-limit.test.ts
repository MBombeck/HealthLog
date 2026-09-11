/**
 * The email-address conflict answer is metered, and metered before it answers.
 *
 * `applyProfileUpdate` is the one place both profile routes reach, and its
 * 409 tells any signed-in caller whether a given address belongs to an
 * account on this instance. Until this bucket existed neither route had a
 * ceiling of any kind — `apiHandler` supplies none — so one account could
 * walk an address book at whatever rate the network allowed.
 *
 * Three things are pinned here. The charge happens BEFORE the uniqueness
 * probe, so a refused request never learns the answer it was refused for.
 * A save that carries the address already on file is not charged at all, so
 * a settings form that re-posts the whole profile does not spend an honest
 * afternoon of edits on the ceiling. And the refusal carries the code the
 * contract publishes.
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

  it("refuses with 429 and the published code, without asking about the address", async () => {
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
