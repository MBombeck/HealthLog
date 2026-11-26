import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  apiPath: undefined as string | undefined,
  pagePath: null as string | null,
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    session: { update: vi.fn(async () => ({})) },
    user: { findUnique: vi.fn() },
  },
}));
vi.mock("@/lib/logging/context", () => ({
  getEvent: () =>
    state.apiPath === undefined
      ? undefined
      : { getHttpPath: () => state.apiPath },
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => state.pagePath })),
}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((to: string) => {
    throw new Error(`redirect:${to}`);
  }),
}));
vi.mock("@/lib/auth/mfa-enrollment", async (importActual) => {
  const actual =
    await importActual<typeof import("@/lib/auth/mfa-enrollment")>();
  const resolveMfaEnrollment = vi.fn();
  return {
    MFA_POLICY_USER_SELECT: actual.MFA_POLICY_USER_SELECT,
    sessionMfaDueAt: actual.sessionMfaDueAt,
    sessionMfaRecordStale: actual.sessionMfaRecordStale,
    resolveMfaEnrollment,
  };
});
vi.mock("@/lib/auth/mfa-grace-notice", () => ({ noticeMfaGrace: vi.fn() }));

import { prisma } from "@/lib/db";
import { resolveMfaEnrollment } from "@/lib/auth/mfa-enrollment";
import { noticeMfaGrace } from "@/lib/auth/mfa-grace-notice";
import {
  enforceMfaEnrollment,
  isMfaEnrollmentApiPath,
  isMfaEnrollmentPagePath,
  callerMfaEnrollment,
  MFA_ENROLLMENT_OPEN_PATHS,
} from "../mfa-confinement";

const PAST = new Date(Date.now() - 60_000);
const USER = {
  id: "u1",
  role: "ADMIN",
  totpConfirmedAt: null,
  mfaEnforced: false,
  createdAt: new Date("2026-01-01T00:00:00Z"),
};

function session(due: Date | null) {
  return { id: "s1", mfaEnrollmentDueAt: due, user: USER };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.apiPath = undefined;
  state.pagePath = null;
  vi.mocked(resolveMfaEnrollment).mockResolvedValue({
    state: "required",
    dueAt: PAST,
  });
});

describe("the enrolment allowlist", () => {
  it("admits the enrolment routes and pages and nothing near them", () => {
    expect(isMfaEnrollmentApiPath("/api/auth/me")).toBe(true);
    expect(isMfaEnrollmentApiPath("/api/auth/me/mfa/totp/setup")).toBe(true);
    expect(isMfaEnrollmentApiPath("/api/auth/logout")).toBe(true);
    expect(isMfaEnrollmentApiPath("/api/auth/me/sessions")).toBe(false);
    expect(isMfaEnrollmentApiPath("/api/measurements")).toBe(false);
    expect(isMfaEnrollmentPagePath("/enroll-mfa")).toBe(true);
    expect(isMfaEnrollmentPagePath("/settings/security")).toBe(true);
    expect(isMfaEnrollmentPagePath("/settings/securityx")).toBe(false);
    expect(isMfaEnrollmentPagePath("/")).toBe(false);
    // Signing out removes the device's push binding: DELETE only.
    expect(isMfaEnrollmentApiPath("/api/devices/d1", "DELETE")).toBe(true);
    expect(isMfaEnrollmentApiPath("/api/devices/d1", "GET")).toBe(false);
    expect(isMfaEnrollmentApiPath("/api/devices/", "DELETE")).toBe(false);
    expect(isMfaEnrollmentApiPath("/api/health")).toBe(true);
    expect(isMfaEnrollmentApiPath("/api/version")).toBe(true);
  });

  it("publishes every rule it applies", () => {
    for (const open of MFA_ENROLLMENT_OPEN_PATHS) {
      const path = open.match === "exact" ? open.path : `${open.path}x`;
      expect(isMfaEnrollmentApiPath(path, open.methods?.[0] ?? "GET")).toBe(
        true,
      );
    }
  });
});

describe("enforceMfaEnrollment", () => {
  it("judges every session by the policy, a recorded date or none", async () => {
    // A session from before the policy carries no date; one recorded under an
    // older policy may say "ahead". Neither decides: the resolution does.
    state.apiPath = "/api/measurements";
    for (const recorded of [null, new Date(Date.now() + 60_000)]) {
      await expect(
        enforceMfaEnrollment(session(recorded)),
      ).rejects.toMatchObject({
        statusCode: 403,
        errorCode: "auth.mfa.enrollment_required",
      });
    }
    expect(resolveMfaEnrollment).toHaveBeenCalledTimes(2);
  });

  it("records the resolved date without rewriting a past one per request", async () => {
    state.apiPath = "/api/auth/me";
    const fresh = session(null);
    await enforceMfaEnrollment(fresh);
    expect(prisma.session.update).toHaveBeenCalledWith({
      where: { id: "s1" },
      data: { mfaEnrollmentDueAt: PAST },
    });
    vi.mocked(prisma.session.update).mockClear();
    // A per-account enforcement resolves to "due now" on every call.
    vi.mocked(resolveMfaEnrollment).mockResolvedValue({
      state: "required",
      dueAt: new Date(),
    });
    await enforceMfaEnrollment(session(PAST));
    expect(prisma.session.update).not.toHaveBeenCalled();
  });

  it("lets a session in its grace period through, wherever it goes", async () => {
    vi.mocked(resolveMfaEnrollment).mockResolvedValue({
      state: "grace",
      dueAt: new Date(Date.now() + 60_000),
    });
    state.apiPath = "/api/measurements";
    await expect(enforceMfaEnrollment(session(null))).resolves.toBeUndefined();
  });

  it("refuses an API route outside the allowlist past the due date", async () => {
    state.apiPath = "/api/measurements";
    await expect(enforceMfaEnrollment(session(PAST))).rejects.toMatchObject({
      statusCode: 403,
      errorCode: "auth.mfa.enrollment_required",
    });
  });

  it("lets the enrolment routes through", async () => {
    state.apiPath = "/api/auth/me/mfa/totp/confirm";
    await expect(enforceMfaEnrollment(session(PAST))).resolves.toBeUndefined();
  });

  it("sends a page render to the enrolment page, except the enrolment pages", async () => {
    state.pagePath = "/dashboard";
    await expect(enforceMfaEnrollment(session(PAST))).rejects.toThrow(
      "redirect:/enroll-mfa",
    );
    state.pagePath = "/settings/security";
    await expect(enforceMfaEnrollment(session(PAST))).resolves.toBeUndefined();
  });

  it("fails closed for a request whose path it cannot tell", async () => {
    await expect(enforceMfaEnrollment(session(PAST))).rejects.toThrow(
      "redirect:/enroll-mfa",
    );
  });

  it("clears the stamp once the account no longer has to enrol", async () => {
    vi.mocked(resolveMfaEnrollment).mockResolvedValue({
      state: "none",
      dueAt: null,
    });
    state.apiPath = "/api/measurements";
    const s = session(PAST);
    await expect(enforceMfaEnrollment(s)).resolves.toBeUndefined();
    expect(prisma.session.update).toHaveBeenCalledWith({
      where: { id: "s1" },
      data: { mfaEnrollmentDueAt: null },
    });
    expect(s.mfaEnrollmentDueAt).toBeNull();
  });
});

describe("callerMfaEnrollment", () => {
  it("reads none for a narrow token without asking the policy", async () => {
    expect(await callerMfaEnrollment(USER, "narrow-token")).toEqual({
      state: "none",
      dueAt: null,
    });
    expect(resolveMfaEnrollment).not.toHaveBeenCalled();
    expect(noticeMfaGrace).not.toHaveBeenCalled();
  });

  it("hands a sign-in's state to the grace notice", async () => {
    const grace = {
      state: "grace" as const,
      dueAt: new Date(Date.now() + 60_000),
    };
    vi.mocked(resolveMfaEnrollment).mockResolvedValue(grace);
    expect(await callerMfaEnrollment(USER, "sign-in")).toEqual(grace);
    expect(noticeMfaGrace).toHaveBeenCalledWith("u1", grace);
  });

  it("answers what the gates enforce for a sign-in", async () => {
    expect((await callerMfaEnrollment(USER, "sign-in")).state).toBe("required");
  });
});
