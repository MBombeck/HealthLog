import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    medication: { findUnique: vi.fn() },
    medicationInventoryItem: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
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
import { PATCH, DELETE } from "../[itemId]/route";
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

describe("GET /api/medications/[id]/inventory", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await GET(
      new NextRequest("http://localhost/api/medications/med-1/inventory"),
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
      new NextRequest("http://localhost/api/medications/med-1/inventory"),
      { params: Promise.resolve({ id: "med-1" }) },
    );
    expect(res.status).toBe(404);
  });

  it("returns the inventory list for the owned medication", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medication.findUnique).mockResolvedValue(MED_OK as never);
    vi.mocked(prisma.medicationInventoryItem.findMany).mockResolvedValue([
      { id: "inv-1", state: "ACTIVE" },
      { id: "inv-2", state: "IN_USE" },
    ] as never);

    const res = await GET(
      new NextRequest("http://localhost/api/medications/med-1/inventory"),
      { params: Promise.resolve({ id: "med-1" }) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { items: unknown[]; meta: { total: number } };
    };
    expect(body.data.items).toHaveLength(2);
    expect(body.data.meta.total).toBe(2);
  });
});

describe("POST /api/medications/[id]/inventory", () => {
  it("rejects unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await POST(
      jsonReq("http://localhost/api/medications/med-1/inventory", {
        dosesTotal: 4,
      }),
      { params: Promise.resolve({ id: "med-1" }) },
    );
    expect(res.status).toBe(401);
  });

  it("returns 422 when dosesTotal is missing or invalid", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medication.findUnique).mockResolvedValue(MED_OK as never);
    const res = await POST(
      jsonReq("http://localhost/api/medications/med-1/inventory", {
        dosesTotal: 0,
      }),
      { params: Promise.resolve({ id: "med-1" }) },
    );
    expect(res.status).toBe(422);
  });

  it("creates an ACTIVE pen with computed expiresAt", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medication.findUnique).mockResolvedValue(MED_OK as never);
    vi.mocked(prisma.medicationInventoryItem.create).mockResolvedValue({
      id: "inv-new",
      state: "ACTIVE",
    } as never);

    const printed = "2027-06-01T00:00:00Z";
    const res = await POST(
      jsonReq("http://localhost/api/medications/med-1/inventory", {
        dosesTotal: 4,
        printedExpiry: printed,
      }),
      { params: Promise.resolve({ id: "med-1" }) },
    );
    expect(res.status).toBe(201);
    expect(prisma.medicationInventoryItem.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "user-1",
        medicationId: "med-1",
        state: "ACTIVE",
        dosesTotal: 4,
        dosesRemaining: 4,
        firstUseAt: null,
        printedExpiry: new Date(printed),
        expiresAt: new Date(printed),
      }),
    });
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
      jsonReq("http://localhost/api/medications/med-1/inventory", {
        dosesTotal: 4,
      }),
      { params: Promise.resolve({ id: "med-1" }) },
    );
    expect(res.status).toBe(429);
  });
});

describe("PATCH /api/medications/[id]/inventory/[itemId]", () => {
  const existingActive = {
    id: "inv-1",
    userId: "user-1",
    medicationId: "med-1",
    state: "ACTIVE" as const,
    dosesTotal: 4,
    dosesRemaining: 4,
    firstUseAt: null,
    printedExpiry: null,
    purchasedAt: null,
    notes: null,
    expiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it("flips ACTIVE → IN_USE on markAsFirstUseAt", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medicationInventoryItem.findUnique).mockResolvedValue(
      existingActive as never,
    );
    vi.mocked(prisma.medicationInventoryItem.update).mockResolvedValue({
      ...existingActive,
      state: "IN_USE",
    } as never);

    const intake = "2026-05-14T12:00:00Z";
    const res = await PATCH(
      jsonReq(
        "http://localhost/api/medications/med-1/inventory/inv-1",
        { markAsFirstUseAt: intake },
        "PATCH",
      ),
      { params: Promise.resolve({ id: "med-1", itemId: "inv-1" }) },
    );
    expect(res.status).toBe(200);
    const updateCall = vi.mocked(prisma.medicationInventoryItem.update).mock
      .calls[0][0];
    expect(updateCall.data).toMatchObject({
      state: "IN_USE",
      firstUseAt: new Date(intake),
    });
  });

  it("flips state to USED_UP and zeros remaining on markAsUsedUp", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medicationInventoryItem.findUnique).mockResolvedValue({
      ...existingActive,
      state: "IN_USE",
      firstUseAt: new Date("2026-05-01"),
      dosesRemaining: 2,
    } as never);
    vi.mocked(prisma.medicationInventoryItem.update).mockResolvedValue({
      ...existingActive,
      state: "USED_UP",
      dosesRemaining: 0,
    } as never);

    const res = await PATCH(
      jsonReq(
        "http://localhost/api/medications/med-1/inventory/inv-1",
        { markAsUsedUp: true },
        "PATCH",
      ),
      { params: Promise.resolve({ id: "med-1", itemId: "inv-1" }) },
    );
    expect(res.status).toBe(200);
    const updateCall = vi.mocked(prisma.medicationInventoryItem.update).mock
      .calls[0][0];
    expect(updateCall.data).toMatchObject({
      state: "USED_UP",
      dosesRemaining: 0,
    });
  });

  it("flips ACTIVE → EXPIRED when markAsFirstUseAt is more than 30 days back-dated", async () => {
    // Regression for the W19b state-machine bypass: composing the next
    // state by hand sent ACTIVE → IN_USE on any first-use stamp, but a
    // back-dated stamp whose 30-day window already lapsed must land at
    // EXPIRED. Re-running `computeInventoryState` after the composed
    // view closes the gap.
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medicationInventoryItem.findUnique).mockResolvedValue(
      existingActive as never,
    );
    vi.mocked(prisma.medicationInventoryItem.update).mockResolvedValue({
      ...existingActive,
      state: "EXPIRED",
    } as never);

    // 45 days in the past — well past the 30-day in-use window.
    const backdated = new Date(
      Date.now() - 45 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const res = await PATCH(
      jsonReq(
        "http://localhost/api/medications/med-1/inventory/inv-1",
        { markAsFirstUseAt: backdated },
        "PATCH",
      ),
      { params: Promise.resolve({ id: "med-1", itemId: "inv-1" }) },
    );
    expect(res.status).toBe(200);
    const updateCall = vi.mocked(prisma.medicationInventoryItem.update).mock
      .calls[0][0];
    expect(updateCall.data).toMatchObject({
      state: "EXPIRED",
      firstUseAt: new Date(backdated),
    });
  });

  it("rejects 404 when the item belongs to another user", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medicationInventoryItem.findUnique).mockResolvedValue({
      ...existingActive,
      userId: "OTHER",
    } as never);

    const res = await PATCH(
      jsonReq(
        "http://localhost/api/medications/med-1/inventory/inv-1",
        { markAsUsedUp: true },
        "PATCH",
      ),
      { params: Promise.resolve({ id: "med-1", itemId: "inv-1" }) },
    );
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/medications/[id]/inventory/[itemId]", () => {
  it("hard-deletes the row and audit-logs the final state", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medicationInventoryItem.findUnique).mockResolvedValue({
      id: "inv-1",
      userId: "user-1",
      medicationId: "med-1",
      state: "EXPIRED",
      dosesRemaining: 2,
    } as never);
    vi.mocked(prisma.medicationInventoryItem.delete).mockResolvedValue({
      id: "inv-1",
    } as never);

    const res = await DELETE(
      new NextRequest("http://localhost/api/medications/med-1/inventory/inv-1", {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: "med-1", itemId: "inv-1" }) },
    );
    expect(res.status).toBe(200);
    expect(prisma.medicationInventoryItem.delete).toHaveBeenCalledWith({
      where: { id: "inv-1" },
    });
  });
});

describe("POST /api/medications/[id]/inventory — 422 multi-issue (v1.4.43 W6)", () => {
  it("surfaces TWO simultaneous validation errors", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medication.findUnique).mockResolvedValue(MED_OK as never);
    const res = await POST(
      jsonReq("http://localhost/api/medications/med-1/inventory", {
        dosesTotal: "string",
        printedExpiry: "not-iso",
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
      jsonReq("http://localhost/api/medications/med-1/inventory", {
        dosesTotal: "string",
        printedExpiry: "not-iso",
        purchasedAt: "also-not-iso",
        notes: 123,
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
