import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => {
  // v1.32.22 (M5) — the [itemId] PATCH / DELETE now run inside a transaction
  // that takes the per-medication advisory lock. The mock transaction runs the
  // callback with the base client as tx, and `$queryRaw` stands in for the
  // advisory-lock query.
  const prisma: Record<string, unknown> = {
    medication: { findUnique: vi.fn() },
    medicationInventoryItem: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    $queryRaw: vi.fn(),
    $transaction: vi.fn((fn: (tx: unknown) => unknown) => fn(prisma)),
  };
  return { prisma };
});

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({
    allowed: true,
    limit: 60,
    remaining: 29,
    resetAt: Date.now() + 60_000,
  }),
  rateLimitHeaders: vi.fn(() => ({})),
}));

vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));

vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserMedications: vi.fn(),
}));

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
import { invalidateUserMedications } from "@/lib/cache/invalidate";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "testuser", role: "USER" as const },
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
  // `resetAllMocks` clears the transaction implementation — re-establish it.
  (
    prisma as unknown as { $transaction: ReturnType<typeof vi.fn> }
  ).$transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
    fn(prisma),
  );
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    limit: 60,
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

  // v1.19.0 (iOS#25) — the GET response carries a server-computed supply
  // summary so the detail-page clients render the canonical Bestand
  // instead of re-deriving it. ACTIVE / IN_USE with units pool in;
  // EXPIRED surfaces separately and never counts as available.
  it("returns a server-computed supply summary (dose-derived, expired separate)", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medication.findUnique).mockResolvedValue({
      id: "med-1",
      userId: "user-1",
      unitsPerDose: 2,
    } as never);
    vi.mocked(prisma.medicationInventoryItem.findMany).mockResolvedValue([
      { id: "inv-1", state: "IN_USE", unitsTotal: 4, unitsRemaining: 3 },
      { id: "inv-2", state: "ACTIVE", unitsTotal: 4, unitsRemaining: 4 },
      { id: "inv-3", state: "EXPIRED", unitsTotal: 4, unitsRemaining: 4 },
      { id: "inv-4", state: "USED_UP", unitsTotal: 4, unitsRemaining: 0 },
    ] as never);

    const res = await GET(
      new NextRequest("http://localhost/api/medications/med-1/inventory"),
      { params: Promise.resolve({ id: "med-1" }) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        summary: {
          unitsRemaining: number;
          unitsTotal: number;
          dosesRemaining: number;
          dosesTotal: number;
          expiredUnits: number;
        };
      };
    };
    // 7 available units / 2 per dose = 3 doses; capacity 8 units = 4 doses;
    // 4 units sit in the expired container (visible, never available).
    expect(body.data.summary).toEqual({
      unitsRemaining: 7,
      unitsTotal: 8,
      dosesRemaining: 3,
      dosesTotal: 4,
      expiredUnits: 4,
    });
  });
});

describe("POST /api/medications/[id]/inventory", () => {
  it("rejects unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await POST(
      jsonReq("http://localhost/api/medications/med-1/inventory", {
        unitsTotal: 4,
      }),
      { params: Promise.resolve({ id: "med-1" }) },
    );
    expect(res.status).toBe(401);
  });

  it("returns 422 when unitsTotal is missing or invalid", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medication.findUnique).mockResolvedValue(MED_OK as never);
    const res = await POST(
      jsonReq("http://localhost/api/medications/med-1/inventory", {
        unitsTotal: 0,
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

    // Now-anchored so the fixture can never age into a past expiry.
    const printed = new Date(
      Date.now() + 300 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const res = await POST(
      jsonReq("http://localhost/api/medications/med-1/inventory", {
        unitsTotal: 4,
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
        containerType: "OTHER",
        unitsTotal: 4,
        unitsRemaining: 4,
        firstUseAt: null,
        printedExpiry: new Date(printed),
        expiresAt: new Date(printed),
      }),
    });
    // Staleness regression: the dose-derived stock the medications-list
    // payload carries must hard-evict on a registration so the card / table
    // reflect the new supply on the very next read (not after the SWR
    // stale window). Mark-stale would serve the pre-write stock.
    expect(invalidateUserMedications).toHaveBeenCalledWith("user-1", {
      evict: true,
    });
  });

  it("returns 429 when the rate limit is exceeded", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medication.findUnique).mockResolvedValue(MED_OK as never);
    vi.mocked(checkRateLimit).mockResolvedValueOnce({
      allowed: false,
      limit: 60,
      remaining: 0,
      resetAt: Date.now() + 60_000,
    });
    const res = await POST(
      jsonReq("http://localhost/api/medications/med-1/inventory", {
        unitsTotal: 4,
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
    // A pen — the container kind that carries the post-opening clock.
    containerType: "PEN" as const,
    unitsTotal: 4,
    unitsRemaining: 4,
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

    // Anchor first-use to one day ago so the 30-day in-use window is
    // always open relative to "now" — a previously hardcoded date
    // (2026-05-14) silently aged past its window and flipped the expected
    // state to EXPIRED once the wall clock crossed firstUseAt + 30 days.
    const intake = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
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
      unitsRemaining: 2,
    } as never);
    vi.mocked(prisma.medicationInventoryItem.update).mockResolvedValue({
      ...existingActive,
      state: "USED_UP",
      unitsRemaining: 0,
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
      unitsRemaining: 0,
    });
    // Staleness regression: a stock-affecting correction must hard-evict
    // the medications-list bucket so the card reflects the change next read.
    expect(invalidateUserMedications).toHaveBeenCalledWith("user-1", {
      evict: true,
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

  it("leaves a back-dated first use on a blister IN_USE with no expiresAt", async () => {
    // The same back-dated stamp on a tablet pack must not write the
    // remaining tablets off: a blister carries no post-opening clock,
    // so the only deadline it could have is a printed one, and this row
    // has none.
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medicationInventoryItem.findUnique).mockResolvedValue({
      ...existingActive,
      containerType: "BLISTER",
      unitsTotal: 60,
      unitsRemaining: 54,
    } as never);
    vi.mocked(prisma.medicationInventoryItem.update).mockResolvedValue({
      ...existingActive,
      state: "IN_USE",
    } as never);

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
      state: "IN_USE",
      firstUseAt: new Date(backdated),
      expiresAt: null,
    });
  });

  it("clears the opening date when markAsFirstUseAt is null", async () => {
    // The correction path for a container the consumption hook
    // auto-opened by mistake: unsetting the date returns the row to
    // ACTIVE and drops any in-use deadline with it.
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medicationInventoryItem.findUnique).mockResolvedValue({
      ...existingActive,
      state: "IN_USE",
      firstUseAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
      expiresAt: new Date(Date.now() + 25 * 24 * 60 * 60 * 1000),
    } as never);
    vi.mocked(prisma.medicationInventoryItem.update).mockResolvedValue({
      ...existingActive,
      state: "ACTIVE",
    } as never);

    const res = await PATCH(
      jsonReq(
        "http://localhost/api/medications/med-1/inventory/inv-1",
        { markAsFirstUseAt: null },
        "PATCH",
      ),
      { params: Promise.resolve({ id: "med-1", itemId: "inv-1" }) },
    );
    expect(res.status).toBe(200);
    const updateCall = vi.mocked(prisma.medicationInventoryItem.update).mock
      .calls[0][0];
    expect(updateCall.data).toMatchObject({
      state: "ACTIVE",
      firstUseAt: null,
      expiresAt: null,
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
      unitsRemaining: 2,
    } as never);
    vi.mocked(prisma.medicationInventoryItem.delete).mockResolvedValue({
      id: "inv-1",
    } as never);

    const res = await DELETE(
      new NextRequest(
        "http://localhost/api/medications/med-1/inventory/inv-1",
        {
          method: "DELETE",
        },
      ),
      { params: Promise.resolve({ id: "med-1", itemId: "inv-1" }) },
    );
    expect(res.status).toBe(200);
    expect(prisma.medicationInventoryItem.delete).toHaveBeenCalledWith({
      where: { id: "inv-1" },
    });
    // Staleness regression: removing a container drops the dose-derived
    // stock the list payload reports — hard-evict so it reflects next read.
    expect(invalidateUserMedications).toHaveBeenCalledWith("user-1", {
      evict: true,
    });
  });
});

describe("POST /api/medications/[id]/inventory — 422 multi-issue (v1.4.43 W6)", () => {
  it("surfaces TWO simultaneous validation errors", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medication.findUnique).mockResolvedValue(MED_OK as never);
    const res = await POST(
      jsonReq("http://localhost/api/medications/med-1/inventory", {
        unitsTotal: "string",
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
        unitsTotal: "string",
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

describe("POST /api/medications/[id]/inventory — carton labelling", () => {
  it("persists manufacturer + doseStrength when the client sends them", async () => {
    // The native pen list uses these two as its headline and subhead. With
    // nowhere on the server to hold them, a container registered on the web
    // could not be rendered there at all.
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medication.findUnique).mockResolvedValue(MED_OK as never);
    vi.mocked(prisma.medicationInventoryItem.create).mockResolvedValue({
      id: "inv-new",
      state: "ACTIVE",
    } as never);

    const res = await POST(
      jsonReq("http://localhost/api/medications/med-1/inventory", {
        unitsTotal: 4,
        containerType: "PEN",
        manufacturer: "Example Pharma",
        doseStrength: "5 mg/0.5 ml",
      }),
      { params: Promise.resolve({ id: "med-1" }) },
    );

    expect(res.status).toBe(201);
    expect(prisma.medicationInventoryItem.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        manufacturer: "Example Pharma",
        doseStrength: "5 mg/0.5 ml",
      }),
    });
  });

  it("stores null for both when the client omits them", async () => {
    // A plain supply row (blister, bottle) carries no carton labelling, and
    // every row that predates the columns is truthfully null.
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medication.findUnique).mockResolvedValue(MED_OK as never);
    vi.mocked(prisma.medicationInventoryItem.create).mockResolvedValue({
      id: "inv-new",
      state: "ACTIVE",
    } as never);

    const res = await POST(
      jsonReq("http://localhost/api/medications/med-1/inventory", {
        unitsTotal: 30,
        containerType: "BLISTER",
      }),
      { params: Promise.resolve({ id: "med-1" }) },
    );

    expect(res.status).toBe(201);
    expect(prisma.medicationInventoryItem.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        manufacturer: null,
        doseStrength: null,
      }),
    });
  });
});
