import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  checkRecordWriteRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock("@/lib/ai/antigravity-auth-session", () => ({
  cancelAntigravityLogin: vi.fn(),
  startAntigravityLogin: vi.fn(),
  ANTIGRAVITY_LOGIN_FAILURE_MESSAGES: {
    start_failed: "Antigravity login could not start",
    login_failed:
      "Antigravity login failed. Start again and paste the new code.",
    login_timed_out: "Antigravity login timed out. Start again.",
    session_expired: "Login session expired. Start again.",
    empty_code: "Authorization code cannot be empty.",
  },
  AntigravityLoginError: class AntigravityLoginError extends Error {
    constructor(readonly failure: string) {
      super(failure);
      this.name = "AntigravityLoginError";
    }
  },
}));

vi.mock("@/lib/ai/antigravity-capability-cache", () => ({
  forgetAntigravityCapabilities: vi.fn(),
}));

vi.mock("@/lib/ai/antigravity-profile-cleanup", () => ({
  normalizeAntigravityProfileRoot: vi.fn(),
  removeAntigravityProfile: vi.fn(),
}));

import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import {
  startAntigravityLogin,
  AntigravityLoginError,
} from "@/lib/ai/antigravity-auth-session";
import {
  normalizeAntigravityProfileRoot,
  removeAntigravityProfile,
} from "@/lib/ai/antigravity-profile-cleanup";
import { POST } from "../auth/start/route";

const USER_ID = "usr-1";

describe("POST /api/antigravity/auth/start rollback and error safeguards", () => {
  let tempRoot: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tempRoot = mkdtempSync(join(tmpdir(), "hl-auth-start-"));
    vi.mocked(getSession).mockResolvedValue({
      user: { id: USER_ID, email: "user@example.com", role: "USER" },
      session: { id: "sess-1", actingAsUserId: null },
    } as unknown as Awaited<ReturnType<typeof getSession>>);
    vi.mocked(normalizeAntigravityProfileRoot).mockReturnValue(tempRoot);
    vi.spyOn(prisma.user, "findUnique").mockImplementation(vi.fn());
    vi.spyOn(prisma.user, "updateMany").mockImplementation(vi.fn());
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("preserves durable profile pointer with error status when rollback cleanup fails", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      antigravityProfileId: null,
      antigravityConnectionStatus: "connected",
    } as unknown as Awaited<ReturnType<typeof prisma.user.findUnique>>);
    vi.mocked(prisma.user.updateMany).mockResolvedValue({
      count: 1,
    } as Prisma.BatchPayload);

    // startAntigravityLogin fails
    vi.mocked(startAntigravityLogin).mockRejectedValueOnce(
      new AntigravityLoginError("start_failed"),
    );
    // Rollback cleanup fails (returns false)
    vi.mocked(removeAntigravityProfile).mockResolvedValueOnce(false);

    const res = await POST();
    expect(res.status).toBe(500);
    expect(startAntigravityLogin).toHaveBeenCalledWith(
      USER_ID,
      expect.any(String),
      expect.any(String),
    );

    // Must NOT have cleared antigravityProfileId to null on failed cleanup
    const secondUpdateCall = vi.mocked(prisma.user.updateMany).mock.calls[1];
    expect(secondUpdateCall).toBeDefined();
    const updateData = secondUpdateCall[0].data;
    expect(updateData).not.toHaveProperty("antigravityProfileId", null);
    expect(updateData.antigravityConnectionStatus).toBe("error");
  });

  it("clears profile pointer to null when rollback cleanup succeeds", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      antigravityProfileId: null,
      antigravityConnectionStatus: "disconnected",
    } as unknown as Awaited<ReturnType<typeof prisma.user.findUnique>>);
    vi.mocked(prisma.user.updateMany).mockResolvedValue({
      count: 1,
    } as Prisma.BatchPayload);

    vi.mocked(startAntigravityLogin).mockRejectedValueOnce(
      new AntigravityLoginError("start_failed"),
    );
    // Rollback cleanup succeeds
    vi.mocked(removeAntigravityProfile).mockResolvedValueOnce(true);

    const res = await POST();
    expect(res.status).toBe(500);
    expect(startAntigravityLogin).toHaveBeenCalledWith(
      USER_ID,
      expect.any(String),
      expect.any(String),
    );

    const secondUpdateCall = vi.mocked(prisma.user.updateMany).mock.calls[1];
    expect(secondUpdateCall).toBeDefined();
    expect(secondUpdateCall[0].data.antigravityProfileId).toBeNull();
    expect(secondUpdateCall[0].data.antigravityConnectionStatus).toBe(
      "disconnected",
    );
  });

  it("fails with 409 on CAS conflict before creating directory", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      antigravityProfileId: null,
      antigravityConnectionStatus: "disconnected",
    } as unknown as Awaited<ReturnType<typeof prisma.user.findUnique>>);
    // CAS conflict: another request touched profile
    vi.mocked(prisma.user.updateMany).mockResolvedValueOnce({
      count: 0,
    } as Prisma.BatchPayload);

    const res = await POST();
    expect(res.status).toBe(409);
    expect(startAntigravityLogin).not.toHaveBeenCalled();
  });

  it("guards stale connected state after CAS conflict without overwriting other profile", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      antigravityProfileId: "prof-old",
      antigravityConnectionStatus: "connected",
    } as unknown as Awaited<ReturnType<typeof prisma.user.findUnique>>);
    vi.mocked(removeAntigravityProfile).mockResolvedValueOnce(true);
    // CAS conflict on new claim
    vi.mocked(prisma.user.updateMany).mockResolvedValueOnce({
      count: 0,
    } as Prisma.BatchPayload);

    const res = await POST();
    expect(res.status).toBe(409);

    // Guard update runs to disconnect the old profile without touching any new concurrent profile
    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: {
        id: USER_ID,
        antigravityProfileId: "prof-old",
      },
      data: {
        antigravityConnectionStatus: "disconnected",
        antigravityConnectedAt: null,
        antigravityModel: null,
        antigravityCapabilitiesJson: expect.anything(),
      },
    });
  });
});
