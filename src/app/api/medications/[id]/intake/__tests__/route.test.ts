/**
 * v1.4.37 W3 — GET /api/medications/[id]/intake `status` filter tests.
 *
 * Pins the contract added to fix the v1.4.36 regression where
 * `IntakeHistoryListV2` rendered rows with `takenAt:null AND
 * skipped:false` as "Eingenommen". The route now accepts an optional
 * `status` query param:
 *
 *  - default (`status:"all"`) keeps the byte-stable contract for the
 *    iOS Swift client and the dashboard tiles already on the wire.
 *  - `status:"completed"` — taken OR skipped — is what the
 *    detail-page list passes so ambiguous "missed / unconfirmed"
 *    rows stay out of the user-facing table.
 *  - `status:"taken"` / `status:"skipped"` cover the two single-arm
 *    branches future surfaces may need.
 *
 * The route-level guard (404 on cross-user reads) is exercised by
 * the shared `assertMedicationOwnership` test suite — this file only
 * cares about the Prisma `where` fragment derived from the new knob.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    medication: { findUnique: vi.fn() },
    medicationIntakeEvent: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
  },
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

import { GET } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "marc", role: "USER" as const },
};

const MED_OK = { id: "med-1", userId: "user-1" };

function makeRequest(query: string): NextRequest {
  return new NextRequest(
    `http://localhost/api/medications/med-1/intake?${query}`,
  );
}

const ROUTE_PARAMS = { params: Promise.resolve({ id: "med-1" }) };

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(prisma.medication.findUnique).mockResolvedValue(MED_OK as never);
  vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
    [] as never,
  );
  vi.mocked(prisma.medicationIntakeEvent.count).mockResolvedValue(0);
});

describe("GET /api/medications/[id]/intake — status filter", () => {
  it("applies no status filter when `status` is omitted (back-compat)", async () => {
    const res = await GET(makeRequest("limit=25&offset=0"), ROUTE_PARAMS);
    expect(res.status).toBe(200);

    const where = vi.mocked(prisma.medicationIntakeEvent.findMany).mock
      .calls[0][0]?.where;
    expect(where).toEqual({ medicationId: "med-1", userId: "user-1" });
  });

  it("applies no status filter when explicitly passed `status=all`", async () => {
    const res = await GET(
      makeRequest("limit=25&offset=0&status=all"),
      ROUTE_PARAMS,
    );
    expect(res.status).toBe(200);

    const where = vi.mocked(prisma.medicationIntakeEvent.findMany).mock
      .calls[0][0]?.where;
    expect(where).toEqual({ medicationId: "med-1", userId: "user-1" });
  });

  it("filters to confirmed-taken rows for `status=taken`", async () => {
    await GET(makeRequest("status=taken"), ROUTE_PARAMS);
    const where = vi.mocked(prisma.medicationIntakeEvent.findMany).mock
      .calls[0][0]?.where;
    expect(where).toEqual({
      medicationId: "med-1",
      userId: "user-1",
      takenAt: { not: null },
      skipped: false,
    });
  });

  it("filters to skipped rows for `status=skipped`", async () => {
    await GET(makeRequest("status=skipped"), ROUTE_PARAMS);
    const where = vi.mocked(prisma.medicationIntakeEvent.findMany).mock
      .calls[0][0]?.where;
    expect(where).toEqual({
      medicationId: "med-1",
      userId: "user-1",
      skipped: true,
    });
  });

  it("filters to taken-or-skipped rows for `status=completed` (the detail-page contract)", async () => {
    await GET(makeRequest("status=completed"), ROUTE_PARAMS);
    const where = vi.mocked(prisma.medicationIntakeEvent.findMany).mock
      .calls[0][0]?.where;
    expect(where).toEqual({
      medicationId: "med-1",
      userId: "user-1",
      OR: [{ takenAt: { not: null }, skipped: false }, { skipped: true }],
    });
  });

  it("rejects unknown status values with a 422", async () => {
    const res = await GET(makeRequest("status=junk"), ROUTE_PARAMS);
    expect(res.status).toBe(422);
    expect(prisma.medicationIntakeEvent.findMany).not.toHaveBeenCalled();
  });

  it("propagates the `status` value to the count call so totals match the visible page", async () => {
    await GET(makeRequest("status=completed"), ROUTE_PARAMS);
    const countArgs = vi.mocked(prisma.medicationIntakeEvent.count).mock
      .calls[0][0];
    expect(countArgs?.where).toEqual({
      medicationId: "med-1",
      userId: "user-1",
      OR: [{ takenAt: { not: null }, skipped: false }, { skipped: true }],
    });
  });
});
