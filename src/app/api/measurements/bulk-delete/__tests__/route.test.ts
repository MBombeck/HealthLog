/**
 * v1.15.13 — POST /api/measurements/bulk-delete.
 *
 * Asserts the ownership-scoped soft-delete contract: only owned, not-
 * already-tombstoned rows are touched; a forged / foreign id is a silent
 * no-op (no 404 existence leak); the rollup recompute collapses to the
 * unique `(type, day)` set instead of firing one recompute per row; the
 * >200-id cap returns 422.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => {
  const prisma = {
    measurement: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
    auditLog: { create: vi.fn() },
    // The read and the write run in one transaction; the stub hands the
    // callback the same mocked client.
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
  };
  return { prisma };
});

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
  rateLimitHeaders: () => ({}),
}));
vi.mock("@/lib/idempotency", () => ({
  withIdempotency:
    <Args extends unknown[]>(fn: (...args: Args) => Promise<Response>) =>
    (...args: Args) =>
      fn(...args),
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
  const perKey = vi.fn().mockResolvedValue(undefined);
  return {
    // keep the real collapse so the test exercises the actual fan-out logic
    collapseToTypeDayKeys: actual.collapseToTypeDayKeys,
    recomputeBucketsForMeasurement: perKey,
    // The keyed refold, observed as the per-key recomputes it stands for.
    recomputeBucketsForKeys: vi.fn(
      async (
        userId: string,
        keys: Array<{ type: string; measuredAt: Date }>,
      ) => {
        for (const k of keys) await perKey(userId, k.type, k.measuredAt);
      },
    ),
  };
});
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
import { checkRateLimit } from "@/lib/rate-limit";
import { invalidateUserMeasurements } from "@/lib/cache/invalidate";
import { invalidateStatusInsightsForTypes } from "@/lib/insights/status-invalidation";
import { recomputeBucketsForMeasurement } from "@/lib/rollups/measurement-rollups";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "tester", role: "USER" as const },
};

function postReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/measurements/bulk-delete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(prisma.auditLog.create).mockResolvedValue({} as never);
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true } as never);
  // `vi.resetAllMocks()` wipes the factory defaults; the best-effort
  // post-delete hooks must be re-stubbed to resolved promises (the route
  // awaits the rollup recompute and `.catch()`es the insight invalidate).
  vi.mocked(recomputeBucketsForMeasurement).mockResolvedValue(undefined);
  vi.mocked(invalidateStatusInsightsForTypes).mockResolvedValue(undefined);
});

describe("POST /api/measurements/bulk-delete", () => {
  it("soft-deletes only owned, non-tombstoned rows and returns that count", async () => {
    // Caller asked for 3 ids but only 2 are owned + live.
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      {
        id: "m1",
        type: "WEIGHT",
        measuredAt: new Date("2026-01-01T08:00:00Z"),
      },
      {
        id: "m2",
        type: "WEIGHT",
        measuredAt: new Date("2026-01-01T20:00:00Z"),
      },
    ] as never);
    vi.mocked(prisma.measurement.updateMany).mockResolvedValue({
      count: 2,
    } as never);

    const res = await POST(postReq({ ids: ["m1", "m2", "foreign"] }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { deleted: number } };
    expect(body.data.deleted).toBe(2);

    // updateMany is ownership-scoped + filters tombstones — a forged id
    // never 404s, it's just excluded from the count.
    const call = vi.mocked(prisma.measurement.updateMany).mock.calls[0][0];
    expect(call.where).toMatchObject({
      // The write names the rows the scoped read found, never the
      // forged id the caller sent.
      id: { in: ["m1", "m2"] },
      userId: "user-1",
      deletedAt: null,
    });
    expect(call.data).toMatchObject({
      syncVersion: { increment: 1 },
    });
    expect(call.data.deletedAt).toBeInstanceOf(Date);

    // v1.16.7 — interactive write: hard-evict so the SWR readers
    // never serve the pre-write analytics body back to the user.
    expect(invalidateUserMeasurements).toHaveBeenCalledWith("user-1", {
      evict: true,
    });
  });

  it("collapses the rollup recompute to the unique (type, day) set, not per-row", async () => {
    // 4 deleted rows: 2× WEIGHT on the same UTC day, 1× WEIGHT next day,
    // 1× PULSE same day as the first → 3 distinct (type, day) keys.
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      { type: "WEIGHT", measuredAt: new Date("2026-01-01T08:00:00Z") },
      { type: "WEIGHT", measuredAt: new Date("2026-01-01T20:00:00Z") },
      { type: "WEIGHT", measuredAt: new Date("2026-01-02T09:00:00Z") },
      { type: "PULSE", measuredAt: new Date("2026-01-01T10:00:00Z") },
    ] as never);
    vi.mocked(prisma.measurement.updateMany).mockResolvedValue({
      count: 4,
    } as never);

    await POST(postReq({ ids: ["a", "b", "c", "d"] }));

    // 4 rows in, 3 distinct (type, day) recomputes out.
    expect(recomputeBucketsForMeasurement).toHaveBeenCalledTimes(3);
    // And one status re-warm over the distinct types.
    expect(invalidateStatusInsightsForTypes).toHaveBeenCalledTimes(1);
    // A delete is the person's own act: narrated like a hand entry.
    expect(invalidateStatusInsightsForTypes).toHaveBeenCalledWith(
      "user-1",
      ["WEIGHT", "PULSE"],
      { source: "manual" },
    );
  });

  it("is a no-op (deleted: 0) when no id is owned — no rollup, no invalidate", async () => {
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.measurement.updateMany).mockResolvedValue({
      count: 0,
    } as never);

    const res = await POST(postReq({ ids: ["foreign-1", "foreign-2"] }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { deleted: number } };
    expect(body.data.deleted).toBe(0);
    expect(invalidateUserMeasurements).not.toHaveBeenCalled();
    expect(recomputeBucketsForMeasurement).not.toHaveBeenCalled();
    expect(invalidateStatusInsightsForTypes).not.toHaveBeenCalled();
  });

  it("rejects a batch over the 200-id cap with 422", async () => {
    const ids = Array.from({ length: 201 }, (_, i) => `m${i}`);
    const res = await POST(postReq({ ids }));
    expect(res.status).toBe(422);
    expect(prisma.measurement.updateMany).not.toHaveBeenCalled();
  });

  it("rejects an empty id array with 422", async () => {
    const res = await POST(postReq({ ids: [] }));
    expect(res.status).toBe(422);
  });

  it("rejects a body over the 256 KB cap with 413 before parsing", async () => {
    const res = await POST(
      postReq({ ids: ["m1"], pad: "x".repeat(256 * 1024) }),
    );
    expect(res.status).toBe(413);
    expect(prisma.measurement.findMany).not.toHaveBeenCalled();
    expect(prisma.measurement.updateMany).not.toHaveBeenCalled();
  });

  it("429s when the rate limit is exceeded", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({ allowed: false } as never);
    const res = await POST(postReq({ ids: ["m1"] }));
    expect(res.status).toBe(429);
    expect(prisma.measurement.updateMany).not.toHaveBeenCalled();
  });
});
