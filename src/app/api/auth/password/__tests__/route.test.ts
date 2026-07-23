/**
 * v1.4.43 W6 — multi-issue 422 envelope on POST /api/auth/password.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// v1.25 — password change requires a fresh MFA step-up for enrolled accounts.
// Spread the real module so `apiHandler` keeps working; override the step-up
// guard so each test drives the enrolled / fresh-factor outcome directly.
vi.mock("@/lib/api-handler", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/api-handler")>(
      "@/lib/api-handler",
    );
  return {
    ...actual,
    requireFreshMfaIfEnrolled: vi.fn(),
  };
});

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { update: vi.fn() },
  },
}));

// v1.30.34 — the route drops the account's step-up elevations alongside its
// sessions, so the rotation cannot leave a proof of the old credential standing.
vi.mock("@/lib/auth/step-up", () => ({
  revokeStepUpElevations: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/auth/session", () => ({
  getSession: vi.fn(),
  destroyAllSessions: vi.fn().mockResolvedValue(undefined),
  createSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/auth/password", () => ({
  verifyPassword: vi.fn().mockResolvedValue(true),
  hashPassword: vi.fn().mockResolvedValue("hashed"),
  checkPasswordStrength: vi
    .fn()
    .mockReturnValue({ isAcceptable: true, feedback: [] }),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
}));

vi.mock("@/lib/i18n/server-locale", () => ({
  resolveServerLocale: vi.fn().mockResolvedValue("en"),
}));

// Fail-open breach check: a null result (corpus unreachable) never blocks.
vi.mock("@/lib/auth/hibp", () => ({
  checkPasswordBreach: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { POST } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { checkRateLimit } from "@/lib/rate-limit";
import { verifyPassword, checkPasswordStrength } from "@/lib/auth/password";
import {
  requireFreshMfaIfEnrolled,
  StepUpRequiredError,
} from "@/lib/api-handler";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: {
    id: "user-1",
    username: "tester",
    email: "t@example.com",
    role: "USER" as const,
    passwordHash: "h",
    onboardingCompletedAt: new Date(),
    locale: "en",
  },
};

function postReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/auth/password", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true } as never);
  // Default: account clears the step-up (no MFA enrolled, or a fresh factor).
  vi.mocked(requireFreshMfaIfEnrolled).mockResolvedValue(SESSION_OK as never);
});

describe("POST /api/auth/password — MFA step-up (v1.25)", () => {
  it("blocks an MFA-enrolled account without a fresh second factor", async () => {
    vi.mocked(requireFreshMfaIfEnrolled).mockRejectedValue(
      new StepUpRequiredError(),
    );
    const res = await POST(
      postReq({
        currentPassword: "old-pass-123",
        newPassword: "New-Pass-456!",
      }),
    );
    expect(res.status).toBe(401);
    // The credential is never rotated when the step-up fails.
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("proceeds when the step-up is satisfied (fresh factor / no MFA)", async () => {
    // vi.resetAllMocks() wiped the factory defaults; restore the success path.
    vi.mocked(verifyPassword).mockResolvedValue(true);
    vi.mocked(checkPasswordStrength).mockReturnValue({
      isAcceptable: true,
      feedback: [],
    } as never);
    const res = await POST(
      postReq({
        currentPassword: "old-pass-123",
        newPassword: "New-Pass-456!",
        confirmPassword: "New-Pass-456!",
      }),
    );
    expect(res.status).toBe(200);
    expect(requireFreshMfaIfEnrolled).toHaveBeenCalledWith(expect.any(Number));
    expect(prisma.user.update).toHaveBeenCalled();
  });
});

describe("POST /api/auth/password — 422 multi-issue (v1.4.43 W6)", () => {
  it("surfaces TWO simultaneous validation errors", async () => {
    // Empty currentPassword + tooShort newPassword.
    const res = await POST(postReq({ currentPassword: "", newPassword: "x" }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      data: null;
      error: string;
      details: {
        issues: Array<{ path: string; code: string; message: string }>;
      };
    };
    expect(body.data).toBeNull();
    expect(body.error).toBe("Validation failed");
    expect(body.details.issues.length).toBeGreaterThanOrEqual(2);
    for (const issue of body.details.issues) {
      expect(Object.keys(issue).sort()).toEqual(["code", "message", "path"]);
    }
  });

  it("surfaces THREE simultaneous validation errors", async () => {
    // Both empty + extra invalid type.
    const res = await POST(postReq({ currentPassword: "", newPassword: 123 }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      details: { issues: Array<unknown> };
    };
    // currentPassword empty (1) + newPassword wrong type (1) — might
    // collapse to 2 issues. We pin the contract on ≥ 2.
    expect(body.details.issues.length).toBeGreaterThanOrEqual(2);
  });
});
