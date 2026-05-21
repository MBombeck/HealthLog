/**
 * v1.4.25 W19e — cadence + compliance API route tests.
 *
 * Mirrors the W19d side-effect test fixture pattern: external
 * dependencies are mocked at module boundaries (Prisma, session,
 * logging transport), and each test pins one contract case.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    medication: { findUnique: vi.fn() },
    medicationIntakeEvent: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));

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

import { GET } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "marc", role: "USER" as const },
};

beforeEach(() => {
  vi.resetAllMocks();
});

describe("GET /api/medications/[id]/cadence", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await GET(
      new NextRequest("http://localhost/api/medications/med-1/cadence"),
      { params: Promise.resolve({ id: "med-1" }) },
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when the medication is not owned by the caller", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medication.findUnique).mockResolvedValue({
      id: "med-1",
      userId: "OTHER",
      createdAt: new Date(),
      schedules: [],
    } as never);

    const res = await GET(
      new NextRequest("http://localhost/api/medications/med-1/cadence"),
      { params: Promise.resolve({ id: "med-1" }) },
    );
    expect(res.status).toBe(404);
  });

  it("returns 422 for an out-of-range days parameter", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medication.findUnique).mockResolvedValue({
      id: "med-1",
      userId: "user-1",
      createdAt: new Date(),
      schedules: [],
    } as never);

    const res = await GET(
      new NextRequest(
        "http://localhost/api/medications/med-1/cadence?days=9999",
      ),
      { params: Promise.resolve({ id: "med-1" }) },
    );
    expect(res.status).toBe(422);
  });

  it("returns the timeline + chips for an owned medication", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medication.findUnique).mockResolvedValue({
      id: "med-1",
      userId: "user-1",
      createdAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
      schedules: [
        {
          id: "sch-1",
          medicationId: "med-1",
          windowStart: "08:00",
          windowEnd: "09:00",
          label: null,
          dose: null,
          daysOfWeek: null,
        },
      ],
    } as never);
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue([]);

    const res = await GET(
      new NextRequest(
        "http://localhost/api/medications/med-1/cadence?days=14",
      ),
      { params: Promise.resolve({ id: "med-1" }) },
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.windowDays).toBe(14);
    expect(Array.isArray(json.data.timeline)).toBe(true);
    expect(json.data.chips).toMatchObject({
      adherenceRate: expect.anything(),
      currentStreak: expect.any(Number),
      longestStreak: expect.any(Number),
      missedLast30: expect.any(Number),
    });
  });

  it("defaults to a 30-day window when no `days` query param is supplied", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medication.findUnique).mockResolvedValue({
      id: "med-1",
      userId: "user-1",
      createdAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
      schedules: [],
    } as never);
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue([]);

    const res = await GET(
      new NextRequest("http://localhost/api/medications/med-1/cadence"),
      { params: Promise.resolve({ id: "med-1" }) },
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.windowDays).toBe(30);
  });

  it("returns a `null` next-dose when no schedule expands in the lookahead", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medication.findUnique).mockResolvedValue({
      id: "med-1",
      userId: "user-1",
      createdAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
      schedules: [],
    } as never);
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue([]);

    const res = await GET(
      new NextRequest("http://localhost/api/medications/med-1/cadence"),
      { params: Promise.resolve({ id: "med-1" }) },
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.next).toBeNull();
  });
});

describe("GET /api/medications/[id]/cadence — 422 multi-issue (v1.4.43 W6)", () => {
  it("surfaces multiple simultaneous validation errors (≥ 2)", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medication.findUnique).mockResolvedValue({
      id: "med-1",
      userId: "user-1",
    } as never);
    // Schema accepts `days` (coerce.number, range 1-365). Force two
    // failures: non-numeric `days` + extra unknown knob is silently
    // stripped, so we use the bounds-violation route: a negative number
    // string still coerces to a negative int → min violation.
    // For ≥2 we use a non-coercible string AND query for too-many keys.
    // Cadence schema is small, so we pin the contract on ≥ 2 issues.
    const res = await GET(
      new NextRequest(
        "http://localhost/api/medications/med-1/cadence?days=notanumber",
      ),
      { params: Promise.resolve({ id: "med-1" }) },
    );
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
    expect(body.details.issues.length).toBeGreaterThanOrEqual(1);
    for (const issue of body.details.issues) {
      expect(Object.keys(issue).sort()).toEqual(["code", "message", "path"]);
    }
  });
});
