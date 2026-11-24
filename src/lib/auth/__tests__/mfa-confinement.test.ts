import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  apiPath: undefined as string | undefined,
  pagePath: null as string | null,
}));

vi.mock("@/lib/db", () => ({
  prisma: { session: { update: vi.fn() }, user: { findUnique: vi.fn() } },
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
vi.mock("@/lib/auth/mfa-enrollment", () => ({
  resolveMfaEnrollment: vi.fn(),
  sessionMfaDueAt: (e: { state: string; dueAt: Date | null }) =>
    e.state === "none" ? null : e.dueAt,
}));

import { prisma } from "@/lib/db";
import { resolveMfaEnrollment } from "@/lib/auth/mfa-enrollment";
import {
  enforceMfaEnrollment,
  isMfaEnrollmentApiPath,
  isMfaEnrollmentPagePath,
} from "../mfa-confinement";

const PAST = new Date(Date.now() - 60_000);
const USER = {
  id: "u1",
  role: "ADMIN",
  totpConfirmedAt: null,
  mfaEnforced: false,
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
  });
});

describe("enforceMfaEnrollment", () => {
  it("asks nothing of a session without a due date or with one ahead", async () => {
    await enforceMfaEnrollment(session(null));
    await enforceMfaEnrollment(session(new Date(Date.now() + 60_000)));
    expect(resolveMfaEnrollment).not.toHaveBeenCalled();
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
