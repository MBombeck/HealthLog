/**
 * DELETE /api/measurements/by-external-ids — iOS HealthKit deletion-sync.
 *
 * Asserts the origin-scoped soft-delete contract (v1.25, iOS #35): the
 * reconciliation only tombstones rows the app minted through its HealthKit
 * ingestion path (`source = APPLE_HEALTH`). A foreign-origin externalId — one
 * that collides with an integration- or manually-sourced row — is excluded by
 * the source predicate and is a silent no-op, never a delete. Cross-user and
 * idempotency guards stay as before.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
    auditLog: { create: vi.fn() },
  },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserMeasurements: vi.fn(),
}));
// The status re-warm the shared post-mutation tail fires. Mocked at the
// module the tail imports it from; a mock anywhere else is never called, and
// the real one runs the AI capability loader against this file's stub db.
vi.mock("@/lib/insights/status-invalidation", () => ({
  invalidateStatusInsightsForTypes: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/rollups/measurement-rollups", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/rollups/measurement-rollups")
  >("@/lib/rollups/measurement-rollups");
  return {
    collapseToTypeDayKeys: actual.collapseToTypeDayKeys,
    recomputeBucketsForMeasurement: vi.fn().mockResolvedValue(undefined),
    recomputeBucketsForKeys: vi.fn().mockResolvedValue(undefined),
  };
});
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { DELETE } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { invalidateUserMeasurements } from "@/lib/cache/invalidate";
import { invalidateStatusInsightsForTypes } from "@/lib/insights/status-invalidation";
import { recomputeBucketsForMeasurement } from "@/lib/rollups/measurement-rollups";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "tester", role: "USER" as const },
};

function delReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/measurements/by-external-ids", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(prisma.auditLog.create).mockResolvedValue({} as never);
  vi.mocked(recomputeBucketsForMeasurement).mockResolvedValue(undefined);
  vi.mocked(invalidateStatusInsightsForTypes).mockResolvedValue(undefined);
});

describe("DELETE /api/measurements/by-external-ids", () => {
  it("scopes both the pre-fetch and the soft-delete to the app-minted APPLE_HEALTH source", async () => {
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      { type: "WEIGHT", measuredAt: new Date("2026-01-01T08:00:00Z") },
    ] as never);
    vi.mocked(prisma.measurement.updateMany).mockResolvedValue({
      count: 1,
    } as never);

    const res = await DELETE(delReq({ externalIds: ["uuid-aaa"] }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { deletedCount: number } };
    expect(body.data.deletedCount).toBe(1);

    const findWhere = vi.mocked(prisma.measurement.findMany).mock.calls[0]![0]!
      .where;
    expect(findWhere).toMatchObject({
      userId: "user-1",
      source: "APPLE_HEALTH",
      externalId: { in: ["uuid-aaa"] },
      deletedAt: null,
    });

    const updateWhere = vi.mocked(prisma.measurement.updateMany).mock
      .calls[0]![0].where;
    expect(updateWhere).toMatchObject({
      userId: "user-1",
      source: "APPLE_HEALTH",
      externalId: { in: ["uuid-aaa"] },
      deletedAt: null,
    });

    // The deleted row's type is re-warmed; the zero-row case below is the
    // twin that must not reach it.
    // The phone's HealthKit deletions arrive with its sync: the sync gap.
    expect(invalidateStatusInsightsForTypes).toHaveBeenCalledWith(
      "user-1",
      ["WEIGHT"],
      { source: "sync" },
    );
  });

  it("is a no-op for a foreign-origin externalId that collides on a non-app-minted row", async () => {
    // The caller's reconciliation list carries an externalId that, on the
    // server, maps to a WITHINGS-sourced row (a colliding externalUUID). The
    // `source = APPLE_HEALTH` predicate excludes it, so the pre-fetch and the
    // soft-delete both match zero rows.
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.measurement.updateMany).mockResolvedValue({
      count: 0,
    } as never);

    const res = await DELETE(delReq({ externalIds: ["withings-collision"] }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { deletedCount: number } };
    expect(body.data.deletedCount).toBe(0);

    // The delete was still source-scoped (the foreign row was never eligible).
    const updateWhere = vi.mocked(prisma.measurement.updateMany).mock
      .calls[0]![0].where;
    expect(updateWhere).toMatchObject({ source: "APPLE_HEALTH" });

    // Zero deletions → no cache eviction, no rollup recompute, no insight bust.
    expect(invalidateUserMeasurements).not.toHaveBeenCalled();
    expect(recomputeBucketsForMeasurement).not.toHaveBeenCalled();
    expect(invalidateStatusInsightsForTypes).not.toHaveBeenCalled();
  });

  it("returns deletedCount 0 with 200 for an empty externalIds array", async () => {
    const res = await DELETE(delReq({ externalIds: [] }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { deletedCount: number } };
    expect(body.data.deletedCount).toBe(0);
    expect(prisma.measurement.updateMany).not.toHaveBeenCalled();
  });

  it("rejects a batch over the 500-id cap with 422", async () => {
    const externalIds = Array.from({ length: 501 }, (_, i) => `uuid-${i}`);
    const res = await DELETE(delReq({ externalIds }));
    expect(res.status).toBe(422);
    expect(prisma.measurement.updateMany).not.toHaveBeenCalled();
  });
});
