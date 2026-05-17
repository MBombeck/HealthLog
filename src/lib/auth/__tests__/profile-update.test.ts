import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

import { applyProfileUpdate } from "../profile-update";
import { prisma } from "@/lib/db";

const USER_ID = "user-1";

const STUB_USER = {
  id: USER_ID,
  username: "marc",
  displayName: null,
  email: null,
  role: "USER",
  heightCm: null,
  dateOfBirth: null,
  gender: null,
  timezone: "Europe/Berlin",
  locale: null,
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(prisma.user.update).mockResolvedValue(STUB_USER as never);
});

describe("applyProfileUpdate timezone validation", () => {
  it("accepts a valid IANA zone", async () => {
    const result = await applyProfileUpdate(USER_ID, {
      timezone: "Europe/Berlin",
    });
    expect(result.ok).toBe(true);
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
  });

  it("rejects an unknown zone with 422", async () => {
    const result = await applyProfileUpdate(USER_ID, {
      timezone: "Mars/Tharsis",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(422);
      expect(result.message).toMatch(/Invalid IANA timezone/i);
    }
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("rejects an empty-string timezone", async () => {
    const result = await applyProfileUpdate(USER_ID, { timezone: "" });
    expect(result.ok).toBe(false);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("rejects an injection-shaped string", async () => {
    const result = await applyProfileUpdate(USER_ID, {
      timezone: "Europe/Berlin' OR 1=1",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(422);
    }
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});
