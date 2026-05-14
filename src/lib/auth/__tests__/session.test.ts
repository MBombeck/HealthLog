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
import { getSession } from "../session";

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
