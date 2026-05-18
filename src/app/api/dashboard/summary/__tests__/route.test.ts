import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: { groupBy: vi.fn() },
    medicationIntakeEvent: { findMany: vi.fn() },
    // v1.4.38 W-F — the route now uses `$queryRaw` for the per-type
    // latest reading, the 7-day rollup-bucket sparkline, and the
    // 365-day distinct-day streak set. Three raw calls per request,
    // in the order the Promise.all dispatches them.
    $queryRaw: vi.fn(),
  },
}));

vi.mock("@/lib/auth/session", () => ({
  getSession: vi.fn(),
}));

vi.mock("@/lib/logging/transports", () => ({
  emitIfSampled: vi.fn(),
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

import { GET } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { __resetAllCachesForTests } from "@/lib/cache/server-cache";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: {
    id: "user-1",
    username: "marc",
    role: "USER" as const,
    displayName: null,
  },
};

// `apiHandler` always reads `request.url` — even when the inner handler
// ignores it — so we hand it a NextRequest and bypass the inner-handler
// arity check via a cast.
const callGet = GET as unknown as (req: NextRequest) => Promise<Response>;
function makeReq(): NextRequest {
  return new NextRequest("http://localhost/api/dashboard/summary");
}

beforeEach(() => {
  vi.resetAllMocks();
  // v1.4.38 W-F — three `$queryRaw` invocations land inside the
  // Promise.all in the order [latest7d, sparkline, streakDays]. The
  // analytics-cache wrap is also process-local, so we must reset it
  // between tests to keep cross-test isolation.
  __resetAllCachesForTests();
  vi.mocked(prisma.$queryRaw).mockResolvedValue([] as never);
  // v1.4.33 maintainer-item-1 — the route now issues a `groupBy` for
  // per-type all-time count + most-recent timestamp. Default to an
  // empty aggregate so legacy tests keep their "no data" expectations.
  vi.mocked(prisma.measurement.groupBy).mockResolvedValue([] as never);
  vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
    [] as never,
  );
});

describe("GET /api/dashboard/summary", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await callGet(makeReq());
    expect(res.status).toBe(401);
  });

  it("returns the aggregated payload with empty data", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await callGet(makeReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        greeting: { salutation: string; date: string };
        streak: { currentDays: number; longest: number; label: string };
        compliance: { scheduledToday: number; takenToday: number };
        metrics: Array<{ id: string; kind: string; sparkline: number[] }>;
      };
    };
    expect(body.data.greeting.salutation).toBe("Hi, marc");
    expect(body.data.streak.currentDays).toBe(0);
    expect(body.data.compliance.scheduledToday).toBe(0);
    expect(body.data.metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "weight" }),
        expect.objectContaining({ id: "bp" }),
        expect.objectContaining({ id: "pulse" }),
      ]),
    );
  });

  it("emits allTimeCount + lastSeenAt for every base metric (v1.4.33 maintainer-item-1)", async () => {
    // Empty-data path — every metric card still ships the new fields
    // so the iOS client can render a tile + "Letzter Wert vor Xd"
    // hint regardless of whether the route saw any rows in the 7-day
    // window.
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await callGet(makeReq());
    const body = (await res.json()) as {
      data: {
        metrics: Array<{
          id: string;
          allTimeCount: number;
          lastSeenAt: string | null;
        }>;
      };
    };
    const baseIds = body.data.metrics.map((m) => m.id);
    for (const required of ["weight", "bp", "pulse"]) {
      expect(baseIds, `${required} card missing from metrics list`).toContain(
        required,
      );
    }
    for (const card of body.data.metrics) {
      expect(card.allTimeCount, `${card.id} missing allTimeCount`).toBe(0);
      expect(card.lastSeenAt, `${card.id} missing lastSeenAt`).toBeNull();
    }
  });

  it("surfaces lastSeenAt from the historical aggregate even when the 7-day window is empty", async () => {
    // Power-user path — the user has logged weight for years but
    // hasn't touched the app in two weeks. `groupBy` returns the
    // all-time count + most-recent timestamp; the 7-day `findMany`
    // returns empty. The route should still emit the weight card
    // with the historical `lastSeenAt` so the iOS client renders the
    // staleness caption.
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const twoWeeksAgo = new Date(Date.now() - 14 * 86_400_000);
    vi.mocked(prisma.measurement.groupBy).mockResolvedValue([
      {
        type: "WEIGHT",
        _count: { _all: 312 },
        _max: { measuredAt: twoWeeksAgo },
      },
    ] as never);
    const res = await callGet(makeReq());
    const body = (await res.json()) as {
      data: {
        metrics: Array<{
          id: string;
          latestValue: number | null;
          allTimeCount: number;
          lastSeenAt: string | null;
          updatedAt: string | null;
        }>;
      };
    };
    const weight = body.data.metrics.find((m) => m.id === "weight");
    expect(weight, "weight card must be present").toBeDefined();
    expect(weight?.allTimeCount).toBe(312);
    expect(weight?.lastSeenAt).toBe(twoWeeksAgo.toISOString());
    // No 7-day reading → latestValue stays null but updatedAt falls
    // through to the historical timestamp so the iOS client can
    // build the relative-age caption from a single field.
    expect(weight?.latestValue).toBeNull();
    expect(weight?.updatedAt).toBe(twoWeeksAgo.toISOString());
  });

  it("emits optional cards when allTimeCount > 0 but the 7-day window is empty", async () => {
    // Glucose / sleep / steps used to only emit when the 7-day
    // window had a reading. v1.4.33 widens the gate so a metric the
    // user logged once last month still surfaces a tile (latestValue
    // null + lastSeenAt populated → iOS renders the historical
    // hint).
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000);
    vi.mocked(prisma.measurement.groupBy).mockResolvedValue([
      {
        type: "BLOOD_GLUCOSE",
        _count: { _all: 4 },
        _max: { measuredAt: tenDaysAgo },
      },
    ] as never);
    const res = await callGet(makeReq());
    const body = (await res.json()) as {
      data: {
        metrics: Array<{
          id: string;
          allTimeCount: number;
          lastSeenAt: string | null;
        }>;
      };
    };
    const glucose = body.data.metrics.find((m) => m.id === "glucose");
    expect(
      glucose,
      "glucose card must be present (v1.4.33 widened gate)",
    ).toBeDefined();
    expect(glucose?.allTimeCount).toBe(4);
    expect(glucose?.lastSeenAt).toBe(tenDaysAgo.toISOString());
  });

  it("paints the steps sparkline from rollup sum_value, not mean (v1.4.39 W-SUM)", async () => {
    // The ACTIVITY_STEPS tile renders the per-day SUM, not the
    // per-bucket MEAN. The sparkline query feeds the SQL aggregate
    // directly off the `measurement_rollups` row; pinning the
    // returned shape proves the route hands `sum_value` through
    // instead of reconstructing from `mean * count`.
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.measurement.groupBy).mockResolvedValue([
      {
        type: "ACTIVITY_STEPS",
        _count: { _all: 7 },
        _max: { measuredAt: new Date() },
      },
    ] as never);
    // First call: latest7d. Second call: sparkline. Third call:
    // streakDays. Matches the Promise.all order documented in the
    // route's perf-comment.
    vi.mocked(prisma.$queryRaw)
      .mockResolvedValueOnce([
        {
          type: "ACTIVITY_STEPS",
          value: 9999,
          measured_at: new Date(),
        },
      ] as never)
      .mockResolvedValueOnce([
        {
          type: "ACTIVITY_STEPS",
          bucket_start: new Date(),
          mean: 2000,
          count: 4,
          // 8000 ≠ mean × count (4 × 2000 = 8000) but the SUM is the
          // direct rollup column; the fallback path would also hit
          // 8000 here. Use 8120 to prove the route did NOT reconstruct
          // from mean × count.
          sum_value: 8120,
        },
      ] as never)
      .mockResolvedValueOnce([] as never);

    const res = await callGet(makeReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { metrics: Array<{ id: string; sparkline: number[] }> };
    };
    const steps = body.data.metrics.find((m) => m.id === "steps");
    expect(steps?.sparkline).toEqual([8120]);
  });

  it("falls back to mean * count when the legacy sum_value is null (v1.4.39 W-SUM)", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.measurement.groupBy).mockResolvedValue([
      {
        type: "ACTIVITY_STEPS",
        _count: { _all: 7 },
        _max: { measuredAt: new Date() },
      },
    ] as never);
    vi.mocked(prisma.$queryRaw)
      .mockResolvedValueOnce([
        {
          type: "ACTIVITY_STEPS",
          value: 9999,
          measured_at: new Date(),
        },
      ] as never)
      .mockResolvedValueOnce([
        {
          type: "ACTIVITY_STEPS",
          bucket_start: new Date(),
          mean: 2000,
          count: 4,
          sum_value: null,
        },
      ] as never)
      .mockResolvedValueOnce([] as never);

    const res = await callGet(makeReq());
    const body = (await res.json()) as {
      data: { metrics: Array<{ id: string; sparkline: number[] }> };
    };
    const steps = body.data.metrics.find((m) => m.id === "steps");
    // 4 × 2000 — legacy fallback for the boot-backfill convergence
    // window keeps the chart non-empty for pre-v1.4.39 rows.
    expect(steps?.sparkline).toEqual([8000]);
  });

  it("computes intake compliance for today", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockImplementation(((
      args: unknown,
    ) => {
      const a = args as { where: { OR?: unknown } };
      if (!a.where.OR) {
        return Promise.resolve([
          { id: "e1", takenAt: new Date(), skipped: false },
          { id: "e2", takenAt: null, skipped: false },
        ]) as never;
      }
      return Promise.resolve([]) as never;
    }) as never);
    const res = await callGet(makeReq());
    const body = (await res.json()) as {
      data: { compliance: { scheduledToday: number; takenToday: number } };
    };
    expect(body.data.compliance.scheduledToday).toBe(2);
    expect(body.data.compliance.takenToday).toBe(1);
  });
});
