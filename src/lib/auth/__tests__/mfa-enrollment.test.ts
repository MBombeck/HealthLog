import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    appSettings: { findUnique: vi.fn(), upsert: vi.fn() },
    webauthnMfaCredential: { count: vi.fn() },
    passkey: { count: vi.fn() },
    session: { update: vi.fn() },
  },
}));

vi.mock("@/lib/auth/secure-cookie", () => ({
  shouldEmitSecureCookie: () => true,
}));

const cookieStore = { set: vi.fn(), delete: vi.fn(), get: vi.fn() };
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => cookieStore),
}));

import {
  resolveMfaEnrollment,
  resolveMfaEnrollmentRequired,
  syncMfaEnrollCookie,
} from "../mfa-enrollment";
import { prisma } from "@/lib/db";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2027-01-20T12:00:00Z");

function policy(overrides: Record<string, unknown> = {}) {
  return {
    mfaRequired: false,
    mfaRequiredForAdmins: true,
    mfaGraceDays: 14,
    mfaPolicySince: new Date(NOW.getTime() - 3 * DAY_MS),
    ...overrides,
  };
}

function usePolicy(overrides: Record<string, unknown> = {}): void {
  vi.mocked(prisma.appSettings.findUnique).mockResolvedValue(
    policy(overrides) as never,
  );
}

const USER = { totpConfirmedAt: null, mfaEnforced: false, role: "USER" };
const ADMIN = { ...USER, role: "ADMIN" };

beforeEach(() => {
  vi.clearAllMocks();
  usePolicy();
  vi.mocked(prisma.webauthnMfaCredential.count).mockResolvedValue(0 as never);
  vi.mocked(prisma.passkey.count).mockResolvedValue(0 as never);
});

afterEach(() => {
  delete process.env.DEMO_MODE;
});

describe("resolveMfaEnrollment", () => {
  it("answers none (and reads nothing) for an account with confirmed TOTP", async () => {
    const result = await resolveMfaEnrollment(
      "u1",
      { ...ADMIN, totpConfirmedAt: new Date(), mfaEnforced: true },
      NOW,
    );
    expect(result).toEqual({ state: "none", dueAt: null });
    expect(prisma.appSettings.findUnique).not.toHaveBeenCalled();
  });

  it("leaves a user alone under the admin policy", async () => {
    expect(await resolveMfaEnrollment("u1", USER, NOW)).toEqual({
      state: "none",
      dueAt: null,
    });
    expect(prisma.webauthnMfaCredential.count).not.toHaveBeenCalled();
  });

  it("gives an admin the grace period counted from when the policy took effect", async () => {
    const result = await resolveMfaEnrollment("u1", ADMIN, NOW);
    expect(result.state).toBe("grace");
    expect(result.dueAt?.getTime()).toBe(NOW.getTime() + 11 * DAY_MS);
  });

  it("requires enrolment once the grace period is over", async () => {
    usePolicy({ mfaPolicySince: new Date(NOW.getTime() - 15 * DAY_MS) });
    expect((await resolveMfaEnrollment("u1", ADMIN, NOW)).state).toBe(
      "required",
    );
    usePolicy({ mfaPolicySince: new Date(Date.now() - 15 * DAY_MS) });
    expect(await resolveMfaEnrollmentRequired("u1", ADMIN)).toBe(true);
  });

  it("requires at once with a grace period of zero days", async () => {
    usePolicy({ mfaGraceDays: 0 });
    expect((await resolveMfaEnrollment("u1", ADMIN, NOW)).state).toBe(
      "required",
    );
  });

  it("covers every account under the instance policy", async () => {
    usePolicy({ mfaRequired: true, mfaRequiredForAdmins: false });
    expect((await resolveMfaEnrollment("u1", USER, NOW)).state).toBe("grace");
  });

  it("applies a per-account enforcement without grace", async () => {
    usePolicy({ mfaRequiredForAdmins: false });
    const result = await resolveMfaEnrollment(
      "u1",
      { ...USER, mfaEnforced: true },
      NOW,
    );
    expect(result).toEqual({ state: "required", dueAt: NOW });
  });

  it.each([
    ["security key", "webauthnMfaCredential"],
    ["passkey", "passkey"],
  ] as const)("lets a %s satisfy the policy", async (_label, model) => {
    vi.mocked(prisma[model].count).mockResolvedValue(1 as never);
    expect((await resolveMfaEnrollment("u1", ADMIN, NOW)).state).toBe("none");
  });

  it("applies no policy on a public demo", async () => {
    process.env.DEMO_MODE = "true";
    expect((await resolveMfaEnrollment("u1", ADMIN, NOW)).state).toBe("none");
  });

  it("creates the settings row once when an install never saved one", async () => {
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue(null as never);
    vi.mocked(prisma.appSettings.upsert).mockResolvedValue(
      policy({ mfaPolicySince: NOW }) as never,
    );
    const result = await resolveMfaEnrollment("u1", ADMIN, NOW);
    expect(prisma.appSettings.upsert).toHaveBeenCalledTimes(1);
    expect(result.dueAt?.getTime()).toBe(NOW.getTime() + 14 * DAY_MS);
  });
});

describe("syncMfaEnrollCookie", () => {
  it("sets the hint cookie only when enrolment is required", async () => {
    await syncMfaEnrollCookie("u1", ADMIN);
    expect(cookieStore.delete).toHaveBeenCalled();
    expect(cookieStore.set).not.toHaveBeenCalled();
  });

  it("stamps the session's due date when it changed, and only then", async () => {
    const result = await syncMfaEnrollCookie("u1", ADMIN, {
      id: "s1",
      mfaEnrollmentDueAt: null,
    });
    expect(prisma.session.update).toHaveBeenCalledWith({
      where: { id: "s1" },
      data: { mfaEnrollmentDueAt: result.dueAt },
    });

    vi.mocked(prisma.session.update).mockClear();
    await syncMfaEnrollCookie("u1", ADMIN, {
      id: "s1",
      mfaEnrollmentDueAt: result.dueAt,
    });
    expect(prisma.session.update).not.toHaveBeenCalled();
  });
});
