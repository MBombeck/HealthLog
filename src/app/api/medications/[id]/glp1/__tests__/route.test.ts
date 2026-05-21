/**
 * v1.4.25 W21 Fix-K — GLP-1 convenience-route POST tests.
 *
 * Pins the sec-H1 hardening pass: Zod parse, 30/min/user rate-limit,
 * `medication.glp1.update` audit row, bounded `doseValue` / `note` /
 * `effectiveFrom`, XOR refinement between the doseChange / inventory
 * branches. Mirrors the sibling inventory + side-effect fixture
 * pattern so the four routes share one test shape.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    medication: { findUnique: vi.fn() },
    medicationDoseChange: { create: vi.fn() },
    medicationInventoryEvent: { create: vi.fn() },
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
  rateLimitHeaders: vi.fn(() => ({ "X-RateLimit-Remaining": "0" })),
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
import { auditLog } from "@/lib/auth/audit";
import { checkRateLimit } from "@/lib/rate-limit";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "marc", role: "USER" as const },
};

const MED_OK = { id: "med-1", userId: "user-1" };

function jsonReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/medications/med-1/glp1", {
    method: "POST",
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

describe("POST /api/medications/[id]/glp1", () => {
  it("rejects unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await POST(
      jsonReq({
        doseChange: {
          effectiveFrom: "2026-05-14T08:00:00Z",
          doseValue: 0.5,
          doseUnit: "mg",
        },
      }),
      { params: Promise.resolve({ id: "med-1" }) },
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when the medication belongs to a different user", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medication.findUnique).mockResolvedValue({
      id: "med-1",
      userId: "OTHER",
    } as never);
    const res = await POST(
      jsonReq({
        doseChange: {
          effectiveFrom: "2026-05-14T08:00:00Z",
          doseValue: 0.5,
          doseUnit: "mg",
        },
      }),
      { params: Promise.resolve({ id: "med-1" }) },
    );
    expect(res.status).toBe(404);
  });

  it("returns 422 when neither doseChange nor inventory is provided", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medication.findUnique).mockResolvedValue(MED_OK as never);
    const res = await POST(jsonReq({}), {
      params: Promise.resolve({ id: "med-1" }),
    });
    expect(res.status).toBe(422);
  });

  it("returns 422 when both doseChange and inventory are provided", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medication.findUnique).mockResolvedValue(MED_OK as never);
    const res = await POST(
      jsonReq({
        doseChange: {
          effectiveFrom: "2026-05-14T08:00:00Z",
          doseValue: 0.5,
          doseUnit: "mg",
        },
        inventory: { delta: 1, reason: "refill" },
      }),
      { params: Promise.resolve({ id: "med-1" }) },
    );
    expect(res.status).toBe(422);
  });

  it("returns 422 when doseValue is negative", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medication.findUnique).mockResolvedValue(MED_OK as never);
    const res = await POST(
      jsonReq({
        doseChange: {
          effectiveFrom: "2026-05-14T08:00:00Z",
          doseValue: -1,
          doseUnit: "mg",
        },
      }),
      { params: Promise.resolve({ id: "med-1" }) },
    );
    expect(res.status).toBe(422);
  });

  it("returns 422 when doseValue is NaN (not a finite number)", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medication.findUnique).mockResolvedValue(MED_OK as never);
    // JSON cannot encode NaN, but Number.NaN reaches the schema if the
    // client base64-encodes or hand-crafts the body. Simulate the
    // post-decode shape by passing `null` (which fails the finite gate)
    // and `1e400` (which JSON renders as null too) via the same path.
    const res = await POST(
      jsonReq({
        doseChange: {
          effectiveFrom: "2026-05-14T08:00:00Z",
          doseValue: null,
          doseUnit: "mg",
        },
      }),
      { params: Promise.resolve({ id: "med-1" }) },
    );
    expect(res.status).toBe(422);
  });

  it("returns 422 when doseValue exceeds 100 mg cap", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medication.findUnique).mockResolvedValue(MED_OK as never);
    const res = await POST(
      jsonReq({
        doseChange: {
          effectiveFrom: "2026-05-14T08:00:00Z",
          doseValue: 250,
          doseUnit: "mg",
        },
      }),
      { params: Promise.resolve({ id: "med-1" }) },
    );
    expect(res.status).toBe(422);
  });

  it("returns 422 when note exceeds 500 chars", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medication.findUnique).mockResolvedValue(MED_OK as never);
    const res = await POST(
      jsonReq({
        doseChange: {
          effectiveFrom: "2026-05-14T08:00:00Z",
          doseValue: 0.5,
          doseUnit: "mg",
          note: "x".repeat(501),
        },
      }),
      { params: Promise.resolve({ id: "med-1" }) },
    );
    expect(res.status).toBe(422);
  });

  it("returns 422 when effectiveFrom predates 2020", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medication.findUnique).mockResolvedValue(MED_OK as never);
    const res = await POST(
      jsonReq({
        doseChange: {
          effectiveFrom: "1995-01-01T00:00:00Z",
          doseValue: 0.5,
          doseUnit: "mg",
        },
      }),
      { params: Promise.resolve({ id: "med-1" }) },
    );
    expect(res.status).toBe(422);
  });

  it("returns 422 when inventory delta is zero", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medication.findUnique).mockResolvedValue(MED_OK as never);
    const res = await POST(
      jsonReq({ inventory: { delta: 0, reason: "noop" } }),
      { params: Promise.resolve({ id: "med-1" }) },
    );
    expect(res.status).toBe(422);
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
      jsonReq({
        doseChange: {
          effectiveFrom: "2026-05-14T08:00:00Z",
          doseValue: 0.5,
          doseUnit: "mg",
        },
      }),
      { params: Promise.resolve({ id: "med-1" }) },
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("0");
  });

  it("creates a doseChange row and writes a medication.glp1.update audit entry", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medication.findUnique).mockResolvedValue(MED_OK as never);
    vi.mocked(prisma.medicationDoseChange.create).mockResolvedValue({
      id: "dc-new",
      effectiveFrom: new Date("2026-05-14T08:00:00Z"),
      doseValue: 0.5,
      doseUnit: "mg",
      note: null,
    } as never);

    const res = await POST(
      jsonReq({
        doseChange: {
          effectiveFrom: "2026-05-14T08:00:00Z",
          doseValue: 0.5,
          doseUnit: "mg",
        },
      }),
      { params: Promise.resolve({ id: "med-1" }) },
    );
    expect(res.status).toBe(201);
    expect(prisma.medicationDoseChange.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        medicationId: "med-1",
        effectiveFrom: new Date("2026-05-14T08:00:00Z"),
        doseValue: 0.5,
        doseUnit: "mg",
        note: null,
      }),
    });
    expect(auditLog).toHaveBeenCalledWith(
      "medication.glp1.update",
      expect.objectContaining({
        userId: "user-1",
        details: expect.objectContaining({
          medicationId: "med-1",
          kind: "doseChange",
          doseChangeId: "dc-new",
          doseValue: 0.5,
          doseUnit: "mg",
        }),
      }),
    );
  });

  it("creates an inventory row and writes a medication.glp1.update audit entry", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medication.findUnique).mockResolvedValue(MED_OK as never);
    vi.mocked(prisma.medicationInventoryEvent.create).mockResolvedValue({
      id: "iv-new",
      delta: 1,
      reason: "refill",
    } as never);

    const res = await POST(
      jsonReq({ inventory: { delta: 1, reason: "refill" } }),
      { params: Promise.resolve({ id: "med-1" }) },
    );
    expect(res.status).toBe(201);
    expect(prisma.medicationInventoryEvent.create).toHaveBeenCalledWith({
      data: { medicationId: "med-1", delta: 1, reason: "refill" },
    });
    expect(auditLog).toHaveBeenCalledWith(
      "medication.glp1.update",
      expect.objectContaining({
        userId: "user-1",
        details: expect.objectContaining({
          medicationId: "med-1",
          kind: "inventory",
          inventoryEventId: "iv-new",
          delta: 1,
          reason: "refill",
        }),
      }),
    );
  });
});

describe("POST /api/medications/[id]/glp1 — 422 multi-issue (v1.4.43 W6)", () => {
  it("surfaces TWO simultaneous validation errors", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medication.findUnique).mockResolvedValue(MED_OK as never);
    const res = await POST(
      jsonReq({
        doseChange: {
          effectiveFrom: "not-iso",
          doseValue: "string",
          doseUnit: "mg",
        },
      }),
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

  it("surfaces THREE simultaneous validation errors", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medication.findUnique).mockResolvedValue(MED_OK as never);
    const res = await POST(
      jsonReq({
        doseChange: {
          effectiveFrom: "not-iso",
          doseValue: "string",
          doseUnit: 999,
          note: 123,
        },
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
