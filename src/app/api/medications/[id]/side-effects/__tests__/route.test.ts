/**
 * v1.4.25 W19d — side-effect API route tests.
 *
 * Mirrors the inventory route test fixture pattern: every external
 * dependency is mocked at module boundaries (Prisma, session, audit,
 * rate-limit, logging transport), and each describe block exercises
 * one HTTP verb's contract.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    medication: { findUnique: vi.fn() },
    medicationSideEffect: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({
    allowed: true,
    remaining: 29,
    resetAt: Date.now() + 60_000,
  }),
  rateLimitHeaders: vi.fn(() => ({})),
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

import { GET, POST } from "../route";
import { DELETE } from "../[logId]/route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { checkRateLimit } from "@/lib/rate-limit";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "marc", role: "USER" as const },
};

const MED_OK = { id: "med-1", userId: "user-1" };

function jsonReq(url: string, body: unknown, method = "POST"): NextRequest {
  return new NextRequest(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    remaining: 29,
    resetAt: Date.now() + 60_000,
  });
});

describe("GET /api/medications/[id]/side-effects", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await GET(
      new NextRequest("http://localhost/api/medications/med-1/side-effects"),
      { params: Promise.resolve({ id: "med-1" }) },
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when the medication is not owned by the caller", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medication.findUnique).mockResolvedValue({
      id: "med-1",
      userId: "OTHER",
    } as never);

    const res = await GET(
      new NextRequest("http://localhost/api/medications/med-1/side-effects"),
      { params: Promise.resolve({ id: "med-1" }) },
    );
    expect(res.status).toBe(404);
  });

  it("returns the logs for the owned medication", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medication.findUnique).mockResolvedValue(MED_OK as never);
    vi.mocked(prisma.medicationSideEffect.findMany).mockResolvedValue([
      { id: "se-1", entry: "NAUSEA", severity: 2 },
      { id: "se-2", entry: "DIARRHEA", severity: 3 },
    ] as never);

    const res = await GET(
      new NextRequest("http://localhost/api/medications/med-1/side-effects"),
      { params: Promise.resolve({ id: "med-1" }) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { items: unknown[]; meta: { total: number } };
    };
    expect(body.data.items).toHaveLength(2);
    expect(body.data.meta.total).toBe(2);
  });

  it("applies from / to / limit query params", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medication.findUnique).mockResolvedValue(MED_OK as never);
    vi.mocked(prisma.medicationSideEffect.findMany).mockResolvedValue(
      [] as never,
    );

    const from = "2026-05-01T00:00:00Z";
    const to = "2026-05-14T00:00:00Z";
    await GET(
      new NextRequest(
        `http://localhost/api/medications/med-1/side-effects?from=${from}&to=${to}&limit=10`,
      ),
      { params: Promise.resolve({ id: "med-1" }) },
    );

    const call = vi.mocked(prisma.medicationSideEffect.findMany).mock.calls[0][0];
    expect(call).toMatchObject({
      where: {
        userId: "user-1",
        medicationId: "med-1",
        occurredAt: { gte: new Date(from), lt: new Date(to) },
      },
      take: 10,
    });
  });
});

describe("POST /api/medications/[id]/side-effects", () => {
  it("rejects unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await POST(
      jsonReq("http://localhost/api/medications/med-1/side-effects", {
        category: "GI",
        entry: "NAUSEA",
        severity: 2,
      }),
      { params: Promise.resolve({ id: "med-1" }) },
    );
    expect(res.status).toBe(401);
  });

  it("returns 422 when severity is out of range", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medication.findUnique).mockResolvedValue(MED_OK as never);
    const res = await POST(
      jsonReq("http://localhost/api/medications/med-1/side-effects", {
        category: "GI",
        entry: "NAUSEA",
        severity: 7,
      }),
      { params: Promise.resolve({ id: "med-1" }) },
    );
    expect(res.status).toBe(422);
  });

  it("derives category server-side and ignores any client-supplied category (v1.4.25 W21 Fix-N / code-M6)", async () => {
    // Client maliciously sends category=INJECTION_SITE for a
    // NAUSEA entry. The server now derives the canonical category
    // from `entry`, so the row lands with category="GI" regardless
    // of the client claim. Backwards-compatible with older clients
    // that still send `category`.
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medication.findUnique).mockResolvedValue(MED_OK as never);
    vi.mocked(prisma.medicationSideEffect.create).mockResolvedValue({
      id: "se-new",
      entry: "NAUSEA",
      category: "GI",
      severity: 2,
    } as never);
    const res = await POST(
      jsonReq("http://localhost/api/medications/med-1/side-effects", {
        category: "INJECTION_SITE",
        entry: "NAUSEA",
        severity: 2,
      }),
      { params: Promise.resolve({ id: "med-1" }) },
    );
    expect(res.status).toBe(201);
    const callArgs = vi.mocked(prisma.medicationSideEffect.create).mock
      .calls[0][0] as { data: { category: string } };
    expect(callArgs.data.category).toBe("GI");
  });

  it("creates a row with the server-derived category", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medication.findUnique).mockResolvedValue(MED_OK as never);
    vi.mocked(prisma.medicationSideEffect.create).mockResolvedValue({
      id: "se-new",
      entry: "NAUSEA",
      category: "GI",
      severity: 2,
    } as never);

    const occurredAt = "2026-05-14T08:00:00Z";
    const res = await POST(
      jsonReq("http://localhost/api/medications/med-1/side-effects", {
        category: "GI",
        entry: "NAUSEA",
        severity: 2,
        occurredAt,
        notes: "after breakfast",
      }),
      { params: Promise.resolve({ id: "med-1" }) },
    );
    expect(res.status).toBe(201);
    expect(prisma.medicationSideEffect.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "user-1",
        medicationId: "med-1",
        category: "GI",
        entry: "NAUSEA",
        severity: 2,
        occurredAt: new Date(occurredAt),
        notes: "after breakfast",
      }),
    });
  });

  it("defaults occurredAt to now when omitted", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medication.findUnique).mockResolvedValue(MED_OK as never);
    vi.mocked(prisma.medicationSideEffect.create).mockResolvedValue({
      id: "se-new",
    } as never);

    const before = Date.now();
    await POST(
      jsonReq("http://localhost/api/medications/med-1/side-effects", {
        category: "GLP1_SPECIFIC",
        entry: "EARLY_SATIETY",
        severity: 3,
      }),
      { params: Promise.resolve({ id: "med-1" }) },
    );
    const after = Date.now();

    const call = vi.mocked(prisma.medicationSideEffect.create).mock.calls[0][0];
    const created = call.data.occurredAt as Date;
    expect(created.getTime()).toBeGreaterThanOrEqual(before);
    expect(created.getTime()).toBeLessThanOrEqual(after);
  });

  it("returns 429 when the rate limit is exceeded", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medication.findUnique).mockResolvedValue(MED_OK as never);
    vi.mocked(checkRateLimit).mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 60_000,
    });
    const res = await POST(
      jsonReq("http://localhost/api/medications/med-1/side-effects", {
        category: "GI",
        entry: "NAUSEA",
        severity: 2,
      }),
      { params: Promise.resolve({ id: "med-1" }) },
    );
    expect(res.status).toBe(429);
  });
});

describe("DELETE /api/medications/[id]/side-effects/[logId]", () => {
  it("returns 401 unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await DELETE(
      new NextRequest(
        "http://localhost/api/medications/med-1/side-effects/se-1",
        { method: "DELETE" },
      ),
      { params: Promise.resolve({ id: "med-1", logId: "se-1" }) },
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when the row belongs to another user", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medicationSideEffect.findUnique).mockResolvedValue({
      id: "se-1",
      userId: "OTHER",
      medicationId: "med-1",
      entry: "NAUSEA",
      severity: 2,
      occurredAt: new Date(),
    } as never);

    const res = await DELETE(
      new NextRequest(
        "http://localhost/api/medications/med-1/side-effects/se-1",
        { method: "DELETE" },
      ),
      { params: Promise.resolve({ id: "med-1", logId: "se-1" }) },
    );
    expect(res.status).toBe(404);
  });

  it("hard-deletes the row and audit-logs entry + severity", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medicationSideEffect.findUnique).mockResolvedValue({
      id: "se-1",
      userId: "user-1",
      medicationId: "med-1",
      entry: "NAUSEA",
      severity: 3,
      occurredAt: new Date("2026-05-14T08:00:00Z"),
    } as never);
    vi.mocked(prisma.medicationSideEffect.delete).mockResolvedValue({
      id: "se-1",
    } as never);

    const res = await DELETE(
      new NextRequest(
        "http://localhost/api/medications/med-1/side-effects/se-1",
        { method: "DELETE" },
      ),
      { params: Promise.resolve({ id: "med-1", logId: "se-1" }) },
    );
    expect(res.status).toBe(200);
    expect(prisma.medicationSideEffect.delete).toHaveBeenCalledWith({
      where: { id: "se-1" },
    });
  });
});

describe("/api/medications/[id]/side-effects — 422 multi-issue (v1.4.43 W6)", () => {
  it("GET surfaces TWO simultaneous validation errors", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medication.findUnique).mockResolvedValue(MED_OK as never);
    // Bad `from` iso + bad `limit` (out of bounds).
    const res = await GET(
      new NextRequest(
        "http://localhost/api/medications/med-1/side-effects?from=not-iso&limit=99999",
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
    expect(body.details.issues.length).toBeGreaterThanOrEqual(2);
    for (const issue of body.details.issues) {
      expect(Object.keys(issue).sort()).toEqual(["code", "message", "path"]);
    }
  });

  it("POST surfaces TWO simultaneous validation errors", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medication.findUnique).mockResolvedValue(MED_OK as never);
    // Missing `entry` + bad `severity`.
    const res = await POST(
      jsonReq("http://localhost/api/medications/med-1/side-effects", {
        severity: "junk",
        notes: "x".repeat(2000),
      }),
      { params: Promise.resolve({ id: "med-1" }) },
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      details: {
        issues: Array<{ path: string; code: string; message: string }>;
      };
    };
    expect(body.details.issues.length).toBeGreaterThanOrEqual(2);
  });

  it("POST surfaces THREE simultaneous validation errors", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medication.findUnique).mockResolvedValue(MED_OK as never);
    const res = await POST(
      jsonReq("http://localhost/api/medications/med-1/side-effects", {
        entry: 999,
        severity: "junk",
        occurredAt: "not-iso",
        notes: "x".repeat(5000),
      }),
      { params: Promise.resolve({ id: "med-1" }) },
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      details: { issues: Array<unknown> };
    };
    expect(body.details.issues.length).toBeGreaterThanOrEqual(3);
  });
});
