import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
  toJson: <T,>(v: T) => v,
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
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

import { GET, PUT } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { auditLog } from "@/lib/auth/audit";
import { DEFAULT_DOCTOR_REPORT_PREFS } from "@/lib/validations/doctor-report-prefs";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "marc", role: "USER" as const },
};

function mkPut(body: unknown): Request {
  return new Request("http://localhost/api/auth/me/doctor-report-prefs", {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/auth/me/doctor-report-prefs", () => {
  it("returns defaults when the column is null", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      doctorReportPrefsJson: null,
    } as never);

    const res = await (GET as (r: Request) => Promise<Response>)(
      new Request("http://localhost/api/auth/me/doctor-report-prefs"),
    );
    expect(res.status).toBe(200);
    const env = (await res.json()) as {
      data: typeof DEFAULT_DOCTOR_REPORT_PREFS;
    };
    expect(env.data).toEqual(DEFAULT_DOCTOR_REPORT_PREFS);
    expect(env.data.mood).toBe(false); // privacy default per Marc
  });
});

describe("PUT /api/auth/me/doctor-report-prefs", () => {
  // ── Case 1 — happy path ─────────────────────────────────────────────
  it("persists the full shape and returns the canonical form", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      doctorReportPrefsJson: null,
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);

    const body = {
      bp: true,
      weight: true,
      pulse: false,
      bmi: true,
      mood: true,
      compliance: true,
      sleep: false,
    };
    const res = await (PUT as (r: Request) => Promise<Response>)(mkPut(body));
    expect(res.status).toBe(200);
    const env = (await res.json()) as { data: typeof body };
    expect(env.data).toEqual(body);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { doctorReportPrefsJson: body },
    });
  });

  // ── Case 2 — partial update layers over current persisted row ───────
  it("merges a partial update over the persisted row", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const current = {
      bp: false,
      weight: false,
      pulse: false,
      bmi: false,
      mood: true,
      compliance: false,
      sleep: false,
    };
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      doctorReportPrefsJson: current,
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);

    // User only flips mood off — every other key keeps its persisted value.
    const res = await (PUT as (r: Request) => Promise<Response>)(
      mkPut({ mood: false }),
    );
    expect(res.status).toBe(200);
    const env = (await res.json()) as { data: typeof current };
    expect(env.data).toEqual({ ...current, mood: false });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { doctorReportPrefsJson: { ...current, mood: false } },
    });
  });

  // ── Case 3 — invalid shape ─────────────────────────────────────────
  it("rejects a non-boolean value with 422", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);

    const res = await (PUT as (r: Request) => Promise<Response>)(
      mkPut({ bp: "nope" }),
    );
    expect(res.status).toBe(422);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  // ── Case 4 — unauthenticated cross-user request ────────────────────
  // Marc's spec mentions "cross-user 404" — the route layer returns 401
  // when there is no session at all, which is the only "you are not the
  // right user" surface available before requireAuth() resolves an
  // identity. `prisma.user.update` must NOT fire in this case.
  it("rejects an unauthenticated request with 401", async () => {
    vi.mocked(getSession).mockResolvedValue(null);

    const res = await (PUT as (r: Request) => Promise<Response>)(
      mkPut({ mood: false }),
    );
    expect(res.status).toBe(401);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  // ── Case 5 — audit trail (v1.4.25 W10 reconcile security M-3) ──────
  it("writes an audit-log entry with the previous and new pref shape", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const current = {
      bp: true,
      weight: true,
      pulse: true,
      bmi: true,
      mood: false,
      compliance: true,
      sleep: true,
    };
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      doctorReportPrefsJson: current,
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);

    const res = await (PUT as (r: Request) => Promise<Response>)(
      mkPut({ mood: true }),
    );
    expect(res.status).toBe(200);
    expect(auditLog).toHaveBeenCalledWith(
      "user.doctor-report-prefs.update",
      expect.objectContaining({
        userId: "user-1",
        details: expect.objectContaining({
          previous: current,
          next: expect.objectContaining({ mood: true }),
        }),
      }),
    );
  });
});
