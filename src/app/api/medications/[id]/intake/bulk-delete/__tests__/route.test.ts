/**
 * v1.5.5 — POST /api/medications/[id]/intake/bulk-delete tests.
 *
 * Pins the contract the detail-page intake-history preview's
 * multi-select Löschen depends on:
 *
 *   - Asserts ownership through the shared `assertMedicationOwnership`
 *     helper. Negative branch returns the helper's 404 response.
 *   - Reads rows scoped by `(eventId IN, userId, medicationId)` so a
 *     leaked id from another medication never deletes anything.
 *   - Recomputes the rollup once per unique dayKey (not once per
 *     event), so a 14-row delete spanning two days closes in two
 *     SQL recompute trips.
 *   - 422 on malformed body via `bulkDeleteIntakeEventsSchema`.
 *   - 200 with `{ deleted: number }` carrying the real `deleteMany`
 *     count so the client toast announces the truth.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    medication: { findUnique: vi.fn() },
    medicationIntakeEvent: {
      findMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    auditLog: { create: vi.fn() },
  },
}));

vi.mock("@/lib/medications/route-guards", () => ({
  assertMedicationOwnership: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({
    allowed: true,
    remaining: 29,
    resetAt: Date.now() + 60_000,
  }),
  rateLimitHeaders: vi.fn(() => ({ "X-RateLimit-Remaining": "0" })),
}));

vi.mock("@/lib/rollups/medication-compliance-rollups", () => ({
  dayKeyForScheduledFor: vi.fn((d: Date) => {
    const iso = d.toISOString();
    return iso.slice(0, 10);
  }),
  recomputeMedicationComplianceForDay: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserMedications: vi.fn(),
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

import { POST } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { assertMedicationOwnership } from "@/lib/medications/route-guards";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  dayKeyForScheduledFor,
  recomputeMedicationComplianceForDay,
} from "@/lib/rollups/medication-compliance-rollups";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "marc", role: "USER" as const },
};

const ROUTE_PARAMS = { params: Promise.resolve({ id: "med-1" }) };

function postWithBody(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/medications/med-1/intake/bulk-delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(assertMedicationOwnership).mockResolvedValue(null);
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    remaining: 29,
    resetAt: Date.now() + 60_000,
  });
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    timezone: "Europe/Berlin",
  } as never);
  vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.medicationIntakeEvent.deleteMany).mockResolvedValue({
    count: 0,
  } as never);
  vi.mocked(prisma.auditLog.create).mockResolvedValue({} as never);
});

describe("POST /api/medications/[id]/intake/bulk-delete", () => {
  it("422 on missing body", async () => {
    const res = await POST(postWithBody({}), ROUTE_PARAMS);
    expect(res.status).toBe(422);
    expect(prisma.medicationIntakeEvent.deleteMany).not.toHaveBeenCalled();
  });

  it("422 on empty eventIds", async () => {
    const res = await POST(postWithBody({ eventIds: [] }), ROUTE_PARAMS);
    expect(res.status).toBe(422);
  });

  it("returns the 404 from the shared ownership helper", async () => {
    vi.mocked(assertMedicationOwnership).mockResolvedValueOnce(
      new Response(null, { status: 404 }) as never,
    );
    const res = await POST(
      postWithBody({ eventIds: ["evt-1"] }),
      ROUTE_PARAMS,
    );
    expect(res.status).toBe(404);
    expect(prisma.medicationIntakeEvent.findMany).not.toHaveBeenCalled();
  });

  it("returns deleted:0 + skips recompute when no matching rows are found", async () => {
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValueOnce(
      [] as never,
    );
    const res = await POST(
      postWithBody({ eventIds: ["evt-leaked", "evt-other"] }),
      ROUTE_PARAMS,
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual({ deleted: 0 });
    expect(prisma.medicationIntakeEvent.deleteMany).not.toHaveBeenCalled();
    expect(recomputeMedicationComplianceForDay).not.toHaveBeenCalled();
  });

  it("recomputes the rollup once per unique dayKey", async () => {
    const day1 = new Date(Date.UTC(2026, 4, 27, 8, 0, 0));
    const day2 = new Date(Date.UTC(2026, 4, 28, 8, 0, 0));
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValueOnce([
      { id: "evt-a", scheduledFor: day1 },
      { id: "evt-b", scheduledFor: day1 },
      { id: "evt-c", scheduledFor: day2 },
    ] as never);
    vi.mocked(prisma.medicationIntakeEvent.deleteMany).mockResolvedValueOnce({
      count: 3,
    } as never);

    const res = await POST(
      postWithBody({ eventIds: ["evt-a", "evt-b", "evt-c"] }),
      ROUTE_PARAMS,
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual({ deleted: 3 });

    expect(dayKeyForScheduledFor).toHaveBeenCalledTimes(3);
    // Three rows, two unique dayKeys → two recompute calls.
    expect(recomputeMedicationComplianceForDay).toHaveBeenCalledTimes(2);
  });

  it("scopes deleteMany by both userId and medicationId", async () => {
    const day1 = new Date(Date.UTC(2026, 4, 27, 8, 0, 0));
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValueOnce([
      { id: "evt-a", scheduledFor: day1 },
    ] as never);
    vi.mocked(prisma.medicationIntakeEvent.deleteMany).mockResolvedValueOnce({
      count: 1,
    } as never);

    await POST(postWithBody({ eventIds: ["evt-a"] }), ROUTE_PARAMS);

    const deleteArg = vi.mocked(prisma.medicationIntakeEvent.deleteMany).mock
      .calls[0][0]?.where;
    expect(deleteArg).toEqual({
      id: { in: ["evt-a"] },
      userId: "user-1",
      medicationId: "med-1",
    });
  });
});

describe("POST /api/medications/[id]/intake/bulk-delete — F-1 H-6 rate limit", () => {
  it("returns 429 when the per-user cap is exhausted", async () => {
    vi.mocked(checkRateLimit).mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 60_000,
    });
    const res = await POST(
      postWithBody({ eventIds: ["evt-a"] }),
      ROUTE_PARAMS,
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(prisma.medicationIntakeEvent.findMany).not.toHaveBeenCalled();
    expect(prisma.medicationIntakeEvent.deleteMany).not.toHaveBeenCalled();
  });

  it("scopes the bucket key to the calling user", async () => {
    await POST(postWithBody({ eventIds: ["evt-a"] }), ROUTE_PARAMS);
    expect(checkRateLimit).toHaveBeenCalledWith(
      "medication-intake-bulk-delete:user-1",
      30,
      60_000,
    );
  });
});
