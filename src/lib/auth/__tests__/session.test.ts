import { describe, it, expect, vi, beforeEach } from "vitest";

const cookieState = vi.hoisted(() => ({
  sessionId: undefined as string | undefined,
  delete: vi.fn(),
  set: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    session: {
      findUnique: vi.fn(),
      deleteMany: vi.fn(),
      update: vi.fn(),
    },
    apiToken: {
      updateMany: vi.fn(),
    },
    refreshToken: {
      updateMany: vi.fn(),
    },
    $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  },
}));

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/logging/context", () => ({
  getEvent: () => undefined,
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) =>
      name === "healthlog_session" && cookieState.sessionId
        ? { value: cookieState.sessionId }
        : undefined,
    set: cookieState.set,
    delete: cookieState.delete,
  })),
}));

import { prisma } from "@/lib/db";
import { getSession, destroyAllSessions } from "../session";

beforeEach(() => {
  vi.resetAllMocks();
  cookieState.sessionId = "sess-expired";
});

describe("getSession", () => {
  it("swallows expired-session delete races and clears cookies", async () => {
    vi.mocked(prisma.session.findUnique).mockResolvedValue({
      id: "sess-expired",
      expiresAt: new Date(Date.now() - 1000),
      user: { id: "user-1" },
    } as never);
    vi.mocked(prisma.session.deleteMany).mockRejectedValue(
      new Error("already deleted") as never,
    );

    await expect(getSession()).resolves.toBeNull();

    expect(prisma.session.deleteMany).toHaveBeenCalledWith({
      where: { id: "sess-expired" },
    });
    expect(cookieState.delete).toHaveBeenCalledWith("healthlog_session");
    expect(cookieState.delete).toHaveBeenCalledWith("hl_onboarding");
  });
});

describe("destroyAllSessions", () => {
  it("revokes web sessions, API tokens, and refresh tokens for the user", async () => {
    vi.mocked(prisma.session.deleteMany).mockResolvedValue({
      count: 2,
    } as never);
    vi.mocked(prisma.apiToken.updateMany).mockResolvedValue({
      count: 1,
    } as never);
    vi.mocked(prisma.refreshToken.updateMany).mockResolvedValue({
      count: 3,
    } as never);

    await destroyAllSessions("user-rotated");

    expect(prisma.session.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-rotated" },
    });
    expect(prisma.apiToken.updateMany).toHaveBeenCalledWith({
      where: { userId: "user-rotated", revoked: false },
      data: { revoked: true },
    });
    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { userId: "user-rotated", revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});
