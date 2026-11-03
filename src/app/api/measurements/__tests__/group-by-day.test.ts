import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * GET /api/measurements has two branches for cumulative HK types (steps,
 * active energy, distance, flights, daylight):
 *
 *   1. `?type=ACTIVITY_STEPS&groupBy=day` → one synthesised row per
 *      user-TZ day, built by `dayGroupedListResponse`. What the rows hold
 *      (whole days, the source ladder, paging, the day cut in the user's
 *      zone) is pinned against Postgres in
 *      `tests/integration/measurements-day-grouped-paging.test.ts`; this
 *      suite pins only which branch a request reaches.
 *   2. `?type=ACTIVITY_STEPS&dayKey=YYYY-MM-DD` → raw per-sample rows
 *      for that single calendar day in the user's IANA timezone.
 *
 * Spot metrics (BP, weight, pulse, etc.) keep the plain list even when
 * these params are present: the route gates each branch on
 * `CUMULATIVE_HK_TYPES`.
 */

vi.mock("@/lib/measurements/list/day-grouped", () => ({
  dayGroupedListResponse: vi.fn(async () =>
    Response.json({ data: { measurements: [], meta: {} }, error: null }),
  ),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
    measurementRollup: {
      findMany: vi.fn(),
    },
    // v1.29.6 — the groupBy=day branch now runs its raw rows through
    // `pickCanonicalSourceRows`, which loads the user's source-priority
    // blob via `loadUserSourcePriority` (prisma.user.findUnique). `null`
    // resolves to the default ladders.
    user: { findUnique: vi.fn() },
    // v1.4.43 — validation-failed paths write an audit breadcrumb.
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    $queryRaw: vi.fn(),
  },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({ auditLog: vi.fn() }));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { GET } from "../route";
import { auditLog } from "@/lib/auth/audit";
import { dayGroupedListResponse } from "@/lib/measurements/list/day-grouped";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: {
    id: "user-1",
    username: "test-user",
    role: "USER" as const,
    timezone: "Europe/Berlin",
  },
};

function getRequest(query: string): NextRequest {
  return new NextRequest(`http://localhost/api/measurements?${query}`, {
    method: "GET",
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  // v1.4.43 — validation-failed paths fire a best-effort audit-row
  // write; the route swallows rejections so the test only needs a
  // resolved mock to keep the catch-block silent.
  vi.mocked(prisma.auditLog.create).mockResolvedValue({} as never);
  // v1.36.0 — the 422 breadcrumb writes through the `auditLog` helper, whose
  // returned promise the route attaches a `.catch` to.
  vi.mocked(auditLog).mockResolvedValue(undefined);
  // v1.29.6 — null source-priority blob → default rank ladders for the
  // groupBy=day canonical-source collapse.
  vi.mocked(prisma.user.findUnique).mockResolvedValue(null as never);
});

describe("GET /api/measurements — groupBy=day", () => {
  it("hands a cumulative type to the day-grouped list with the request's filters", async () => {
    const res = await GET(
      getRequest(
        "type=ACTIVITY_STEPS&groupBy=day&limit=25&offset=50&sourceEq=APPLE_HEALTH&from=2026-05-01T00:00:00Z",
      ),
    );
    expect(res.status).toBe(200);
    expect(dayGroupedListResponse).toHaveBeenCalledWith(
      expect.objectContaining({ id: "user-1" }),
      expect.objectContaining({
        type: "ACTIVITY_STEPS",
        limit: 25,
        offset: 50,
        sortDir: "desc",
        sourceEq: "APPLE_HEALTH",
        from: new Date("2026-05-01T00:00:00Z"),
      }),
    );
    expect(prisma.measurement.findMany).not.toHaveBeenCalled();
  });

  // A day-grouped row is a whole day's sum; a value range filters single
  // readings and would leave partial days behind, so the pair is refused.
  it("refuses a value range beside groupBy=day", async () => {
    const res = await GET(
      getRequest("type=ACTIVITY_STEPS&groupBy=day&valueMin=100"),
    );
    expect(res.status).toBe(422);
    expect(dayGroupedListResponse).not.toHaveBeenCalled();
  });

  it("falls back to the legacy findMany path when groupBy=day is set on a non-cumulative type", async () => {
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      {
        id: "m-1",
        type: "PULSE",
        value: 60,
        unit: "bpm",
        source: "MANUAL",
        measuredAt: new Date("2026-05-15T09:00:00.000Z"),
        notes: null,
      },
    ] as never);
    vi.mocked(prisma.measurement.count).mockResolvedValue(1 as never);

    const res = await GET(getRequest("type=PULSE&groupBy=day"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      data: {
        measurements: Array<{ type: string }>;
        meta: { groupBy?: string };
      };
    };
    // Spot metrics keep the per-sample shape; the collapse branch
    // never fires.
    expect(json.data.meta.groupBy).toBeUndefined();
    expect(json.data.measurements.length).toBe(1);
  });
});

describe("GET /api/measurements — dayKey drill-down", () => {
  it("returns per-sample rows for the requested calendar day in the user's TZ", async () => {
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      {
        id: "m-1",
        type: "ACTIVITY_STEPS",
        value: 1200,
        unit: "steps",
        source: "APPLE_HEALTH",
        measuredAt: new Date("2026-05-15T08:00:00.000Z"),
        notes: null,
      },
      {
        id: "m-2",
        type: "ACTIVITY_STEPS",
        value: 3400,
        unit: "steps",
        source: "APPLE_HEALTH",
        measuredAt: new Date("2026-05-15T15:00:00.000Z"),
        notes: null,
      },
    ] as never);

    const res = await GET(getRequest("type=ACTIVITY_STEPS&dayKey=2026-05-15"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      data: {
        measurements: Array<{ id: string; value: number }>;
        meta: { dayKey?: string };
      };
    };
    expect(json.data.meta.dayKey).toBe("2026-05-15");
    expect(json.data.measurements.length).toBe(2);
    expect(json.data.measurements[0].value).toBe(1200);

    // The route resolves the user-TZ day boundary, so the underlying
    // findMany must be called with measuredAt: { gte, lt } shape.
    const call = vi.mocked(prisma.measurement.findMany).mock.calls[0]?.[0];
    expect(call).toBeDefined();
    const measuredAt = (call as { where: { measuredAt?: unknown } }).where
      .measuredAt as { gte?: Date; lt?: Date };
    expect(measuredAt.gte).toBeInstanceOf(Date);
    expect(measuredAt.lt).toBeInstanceOf(Date);
    // Window is exactly 24 hours wide on a non-DST-transition day for
    // a whole-hour-offset zone. The DST-aware drill-down test below
    // pins the 23-/25-hour shape on the two transition days per year.
    expect(measuredAt.lt!.getTime() - measuredAt.gte!.getTime()).toBe(
      24 * 60 * 60 * 1000,
    );
  });

  // v1.4.37 — DST awareness. The drill-down window must honour
  // the day's true local span (23 h on spring-forward, 25 h on
  // fall-back) so the row count matches what the collapsed daily row
  // displays. Previous shape (`canonicalDailyTimestamp ± 12h`) leaked
  // an hour from the previous day on spring-forward and hid the first
  // hour of `today` on fall-back.
  it("returns a 23-hour window on the Berlin spring-forward day (2025-03-30)", async () => {
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([] as never);
    const res = await GET(getRequest("type=ACTIVITY_STEPS&dayKey=2025-03-30"));
    expect(res.status).toBe(200);
    const call = vi.mocked(prisma.measurement.findMany).mock.calls[0]?.[0];
    const measuredAt = (call as { where: { measuredAt?: unknown } }).where
      .measuredAt as { gte?: Date; lt?: Date };
    expect(measuredAt.gte!.toISOString()).toBe("2025-03-29T23:00:00.000Z");
    expect(measuredAt.lt!.toISOString()).toBe("2025-03-30T22:00:00.000Z");
    expect(measuredAt.lt!.getTime() - measuredAt.gte!.getTime()).toBe(
      23 * 60 * 60 * 1000,
    );
  });

  it("returns a 25-hour window on the Berlin fall-back day (2025-10-26)", async () => {
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([] as never);
    const res = await GET(getRequest("type=ACTIVITY_STEPS&dayKey=2025-10-26"));
    expect(res.status).toBe(200);
    const call = vi.mocked(prisma.measurement.findMany).mock.calls[0]?.[0];
    const measuredAt = (call as { where: { measuredAt?: unknown } }).where
      .measuredAt as { gte?: Date; lt?: Date };
    expect(measuredAt.gte!.toISOString()).toBe("2025-10-25T22:00:00.000Z");
    expect(measuredAt.lt!.toISOString()).toBe("2025-10-26T23:00:00.000Z");
    expect(measuredAt.lt!.getTime() - measuredAt.gte!.getTime()).toBe(
      25 * 60 * 60 * 1000,
    );
  });

  it("rejects a malformed dayKey at the validation gate (no DB call)", async () => {
    const res = await GET(getRequest("type=ACTIVITY_STEPS&dayKey=15.05.2026"));
    expect(res.status).toBe(422);
    expect(prisma.measurement.findMany).not.toHaveBeenCalled();
  });

  it("ignores dayKey on non-cumulative types and falls back to the legacy path", async () => {
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.measurement.count).mockResolvedValue(0 as never);

    const res = await GET(getRequest("type=PULSE&dayKey=2026-05-15"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      data: { meta: { dayKey?: string } };
    };
    // No dayKey echo on the legacy path — proves the drill-down branch
    // didn't fire for the spot metric.
    expect(json.data.meta.dayKey).toBeUndefined();
  });
});

describe("GET /api/measurements — schema rejections", () => {
  // #1245 — the day-grouped mode pages over days, so an offset is a real
  // page request now rather than a refused combination.
  it("accepts offset>0 when groupBy=day is set", async () => {
    const res = await GET(
      getRequest("type=ACTIVITY_STEPS&groupBy=day&offset=25"),
    );
    expect(res.status).toBe(200);
  });

  // v1.4.37 — same restriction for the drill-down branch; it
  // returns a single bounded page per dayKey, not a cursor.
  it("rejects offset>0 when dayKey is set", async () => {
    const res = await GET(
      getRequest("type=ACTIVITY_STEPS&dayKey=2026-05-15&offset=25"),
    );
    expect(res.status).toBe(422);
    expect(prisma.measurement.findMany).not.toHaveBeenCalled();
  });

  // v1.4.37 — `2026-02-30` is a YYYY-MM-DD string but not a
  // real calendar date. `new Date()` silently overflows it to March
  // 2, so the drill-down would point at the wrong day. The validator
  // refine must reject it at parse time.
  it("rejects impossible calendar dates on dayKey (2026-02-30)", async () => {
    const res = await GET(getRequest("type=ACTIVITY_STEPS&dayKey=2026-02-30"));
    expect(res.status).toBe(422);
    expect(prisma.measurement.findMany).not.toHaveBeenCalled();
  });

  it("rejects impossible month on dayKey (2026-13-01)", async () => {
    const res = await GET(getRequest("type=ACTIVITY_STEPS&dayKey=2026-13-01"));
    expect(res.status).toBe(422);
    expect(prisma.measurement.findMany).not.toHaveBeenCalled();
  });
});
