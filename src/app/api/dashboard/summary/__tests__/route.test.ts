import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: { groupBy: vi.fn() },
    medicationIntakeEvent: {
      findMany: vi.fn(),
      // v1.4.39 W-SERVER-FIX-2 — the dashboard route now backfills
      // missing today-rows for daily schedules (parity with the
      // intake route's `expandTodayIntakes` projection) so the iOS
      // Dashboard compliance tile leaves "Heute nichts geplant" the
      // moment a daily med is configured.
      createMany: vi.fn(),
    },
    medication: {
      // v1.4.39 W-SERVER-FIX-2 — projection source for the today's-
      // intakes backfill.
      findMany: vi.fn(),
    },
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
  // v1.4.39 W-SERVER-FIX-2 — default the projection prisma reads to
  // "no active medications" so the legacy tests stay in their original
  // branch (empty today bucket, no backfill firing).
  vi.mocked(prisma.medication.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.medicationIntakeEvent.createMany).mockResolvedValue({
    count: 0,
  } as never);
});

// v1.4.48 L13 — restore real timers no matter how a test exits. A failed
// assertion inside an `it` that opted into fake timers would otherwise
// leak the fake clock into the next test in the file (or, worse, the
// next file in the same vitest worker).
afterEach(() => {
  vi.useRealTimers();
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
    // REG-11 (v1.4.44): weight is the only always-emitted base metric.
    // BP + pulse + bodyFat + optional kinds gate on `latest ||
    // allTimeCount > 0` so accounts that have never logged a kind don't
    // get an empty placeholder tile.
    expect(body.data.metrics).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "weight" })]),
    );
    expect(
      body.data.metrics.find((m) => m.id === "bp"),
      "bp must not emit when allTimeCount === 0 (REG-11)",
    ).toBeUndefined();
    expect(
      body.data.metrics.find((m) => m.id === "pulse"),
      "pulse must not emit when allTimeCount === 0 (REG-11)",
    ).toBeUndefined();
  });

  it("emits allTimeCount + lastSeenAt for the weight card on empty data (v1.4.33 maintainer-item-1)", async () => {
    // REG-11 (v1.4.44): the always-emitted base set shrank to just
    // `weight` — BP + pulse now gate on `latest || allTimeCount > 0`
    // so an account that has never logged either doesn't get a noisy
    // empty tile. Weight still ships unconditionally because the
    // onboarding flow expects the tile as a primary CTA.
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
    expect(baseIds, "weight card missing from metrics list").toContain(
      "weight",
    );
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

  it("emits the BP tile with the historical value when the last reading is 60 days old (REG-11)", async () => {
    // The original 7-day calendar filter in the latest-reading SQL
    // dropped any row outside the trailing-7-day window, so a BP
    // measurement logged 60 days ago surfaced as `latestValue: null`
    // and `sparkline: []` — the iOS tile then had nothing to render.
    // Post-REG-11 the `latestEver` aggregate carries the row + the
    // `ROW_NUMBER`-windowed sparkline carries the trailing 7 daily
    // rollup buckets regardless of how old they are.
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const sixtyDaysAgo = new Date(Date.now() - 60 * 86_400_000);
    const sixtyOneDaysAgo = new Date(Date.now() - 61 * 86_400_000);
    vi.mocked(prisma.measurement.groupBy).mockResolvedValue([
      {
        type: "BLOOD_PRESSURE_SYS",
        _count: { _all: 14 },
        _max: { measuredAt: sixtyDaysAgo },
      },
      {
        type: "BLOOD_PRESSURE_DIA",
        _count: { _all: 14 },
        _max: { measuredAt: sixtyDaysAgo },
      },
    ] as never);
    // Promise.all order: [latestEver, sparkline, streakDays].
    vi.mocked(prisma.$queryRaw)
      .mockResolvedValueOnce([
        {
          type: "BLOOD_PRESSURE_SYS",
          value: 132,
          measured_at: sixtyDaysAgo,
        },
        {
          type: "BLOOD_PRESSURE_DIA",
          value: 84,
          measured_at: sixtyDaysAgo,
        },
      ] as never)
      .mockResolvedValueOnce([
        {
          type: "BLOOD_PRESSURE_SYS",
          bucket_start: sixtyOneDaysAgo,
          mean: 130,
          count: 1,
          sum_value: null,
        },
        {
          type: "BLOOD_PRESSURE_SYS",
          bucket_start: sixtyDaysAgo,
          mean: 132,
          count: 1,
          sum_value: null,
        },
      ] as never)
      .mockResolvedValueOnce([] as never);

    const res = await callGet(makeReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        metrics: Array<{
          id: string;
          latestValue: number | null;
          secondaryValue: number | null;
          sparkline: number[];
          allTimeCount: number;
          lastSeenAt: string | null;
        }>;
      };
    };
    const bp = body.data.metrics.find((m) => m.id === "bp");
    expect(bp, "bp tile must be emitted for stale-but-valid history").toBeDefined();
    expect(bp?.latestValue).toBe(132);
    expect(bp?.secondaryValue).toBe(84);
    expect(bp?.allTimeCount).toBe(28);
    expect(bp?.lastSeenAt).toBe(sixtyDaysAgo.toISOString());
    expect(bp?.sparkline).toEqual([130, 132]);
  });

  it("does NOT emit the BP tile when the account has zero readings ever (REG-11)", async () => {
    // Accounts that have never logged BP should not get an empty
    // placeholder tile. Mirrors the bodyFat gate that's been in place
    // since v1.4.33.
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await callGet(makeReq());
    const body = (await res.json()) as {
      data: { metrics: Array<{ id: string }> };
    };
    expect(
      body.data.metrics.find((m) => m.id === "bp"),
      "bp tile must not emit when no BP reading exists",
    ).toBeUndefined();
    expect(
      body.data.metrics.find((m) => m.id === "pulse"),
      "pulse tile must not emit when no pulse reading exists",
    ).toBeUndefined();
  });

  it("keeps the weight tile fresh when the latest reading is within 7d (REG-11 regression guard)", async () => {
    // The post-REG-11 SQL drops the calendar filter — the recent-path
    // (last reading <7d) must still produce identical output so we
    // don't accidentally regress the fresh-data case.
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000);
    vi.mocked(prisma.measurement.groupBy).mockResolvedValue([
      {
        type: "WEIGHT",
        _count: { _all: 200 },
        _max: { measuredAt: twoDaysAgo },
      },
    ] as never);
    vi.mocked(prisma.$queryRaw)
      .mockResolvedValueOnce([
        { type: "WEIGHT", value: 82.4, measured_at: twoDaysAgo },
      ] as never)
      .mockResolvedValueOnce([
        {
          type: "WEIGHT",
          bucket_start: twoDaysAgo,
          mean: 82.4,
          count: 1,
          sum_value: null,
        },
      ] as never)
      .mockResolvedValueOnce([] as never);

    const res = await callGet(makeReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        metrics: Array<{
          id: string;
          latestValue: number | null;
          sparkline: number[];
          allTimeCount: number;
        }>;
      };
    };
    const weight = body.data.metrics.find((m) => m.id === "weight");
    expect(weight?.latestValue).toBe(82.4);
    expect(weight?.sparkline).toEqual([82.4]);
    expect(weight?.allTimeCount).toBe(200);
  });

  it("sparkline window takes the last 7 daily buckets even when they're all older than 7 days (REG-11)", async () => {
    // The new `ROW_NUMBER() OVER (PARTITION BY type ORDER BY
    // bucket_start DESC)` window guarantees the route asks the DB for
    // exactly the trailing `SPARK_DAYS` buckets per type. Because the
    // SQL runs in Postgres, the mock here only proves the route hands
    // the buckets through in chronological order without dropping any
    // for age. The asserted order matches the SQL `ORDER BY type,
    // bucket_start ASC` so the iOS chart paints left-to-right with the
    // oldest bucket first.
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const days = (n: number) => new Date(Date.now() - n * 86_400_000);
    vi.mocked(prisma.measurement.groupBy).mockResolvedValue([
      {
        type: "PULSE",
        _count: { _all: 42 },
        _max: { measuredAt: days(30) },
      },
    ] as never);
    vi.mocked(prisma.$queryRaw)
      .mockResolvedValueOnce([
        { type: "PULSE", value: 71, measured_at: days(30) },
      ] as never)
      .mockResolvedValueOnce([
        { type: "PULSE", bucket_start: days(36), mean: 68, count: 3, sum_value: null },
        { type: "PULSE", bucket_start: days(35), mean: 70, count: 3, sum_value: null },
        { type: "PULSE", bucket_start: days(34), mean: 69, count: 3, sum_value: null },
        { type: "PULSE", bucket_start: days(33), mean: 71, count: 3, sum_value: null },
        { type: "PULSE", bucket_start: days(32), mean: 73, count: 3, sum_value: null },
        { type: "PULSE", bucket_start: days(31), mean: 72, count: 3, sum_value: null },
        { type: "PULSE", bucket_start: days(30), mean: 71, count: 3, sum_value: null },
      ] as never)
      .mockResolvedValueOnce([] as never);

    const res = await callGet(makeReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        metrics: Array<{
          id: string;
          latestValue: number | null;
          sparkline: number[];
        }>;
      };
    };
    const pulse = body.data.metrics.find((m) => m.id === "pulse");
    expect(pulse, "pulse tile must emit for stale history").toBeDefined();
    expect(pulse?.latestValue).toBe(71);
    expect(pulse?.sparkline).toEqual([68, 70, 69, 71, 73, 72, 71]);
    expect(pulse?.sparkline).toHaveLength(7);
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

  it("backfills today's intakes for daily meds (v1.4.39 W-SERVER-FIX-2)", async () => {
    // The dashboard compliance tile is fed by `todaysIntakes`, the
    // same window the intake route covers. Pre-fix this only read the
    // pre-existing `MedicationIntakeEvent` rows, so a daily med
    // (`daysOfWeek: null`) had `scheduledToday=0` until the reminder
    // worker minted the RED-phase row at the end of the dose window.
    // Post-fix the route projects active schedules through
    // `expandTodayIntakes` + idempotently backfills missing rows, so
    // the iOS Dashboard tile leaves "Heute nichts geplant" the moment
    // a daily med is configured.
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medication.findMany).mockResolvedValue([
      {
        id: "med-ramipril",
        schedules: [
          {
            id: "sched-morgens",
            medicationId: "med-ramipril",
            windowStart: "07:00",
            windowEnd: "09:00",
            daysOfWeek: null,
          },
        ],
      },
    ] as never);
    // The dashboard route now issues three findMany calls in the
    // today path:
    //   1. existence probe (no `OR`) → empty (no rows yet)
    //   2. final read after backfill (no `OR`) → one minted row
    //   3. streak fetch (with `OR`) → empty
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockImplementation(((
      args: unknown,
    ) => {
      const a = args as {
        where: { OR?: unknown };
        select?: { id?: boolean };
      };
      if (a.where.OR) return Promise.resolve([]) as never;
      // No `id` field on the existence-probe `select` → the route
      // only asked for `(medicationId, scheduledFor)`.
      if (!a.select?.id) return Promise.resolve([]) as never;
      return Promise.resolve([
        {
          id: "e-new",
          takenAt: null,
          skipped: false,
        },
      ]) as never;
    }) as never);
    vi.mocked(prisma.medicationIntakeEvent.createMany).mockResolvedValue({
      count: 1,
    } as never);

    const res = await callGet(makeReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { compliance: { scheduledToday: number; takenToday: number } };
    };
    expect(body.data.compliance.scheduledToday).toBe(1);
    expect(body.data.compliance.takenToday).toBe(0);
    expect(prisma.medicationIntakeEvent.createMany).toHaveBeenCalledTimes(1);
    // Race-defense backstop: the createMany call must pass
    // `skipDuplicates: true` so a concurrent intake-route hit can't
    // race a duplicate row in before the existence probe converges.
    const createManyArgs = vi.mocked(prisma.medicationIntakeEvent.createMany)
      .mock.calls[0][0] as {
      data: Array<{
        userId: string;
        medicationId: string;
        skipped: boolean;
        source: string;
      }>;
      skipDuplicates?: boolean;
    };
    expect(createManyArgs.skipDuplicates).toBe(true);
    expect(createManyArgs.data).toEqual([
      expect.objectContaining({
        userId: "user-1",
        medicationId: "med-ramipril",
        skipped: false,
        source: "REMINDER",
      }),
    ]);
  });

  it("is idempotent on a second pass (v1.4.39 W-SERVER-FIX-2)", async () => {
    // When the existence probe already sees a row for the projected
    // slot (e.g. the intake route or the reminder worker minted it
    // first), the dashboard route's backfill `createMany` must not
    // fire — the route simply re-reads + returns.
    //
    // v1.4.47 — pin the wall-clock so the projected scheduledFor and
    // the mocked existence row land on the same day regardless of
    // when the suite runs (previously hard-coded 2026-05-21 — broke
    // on 2026-05-22).
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-21T08:00:00.000Z"));
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const scheduledFor = new Date("2026-05-21T05:00:00.000Z");
    vi.mocked(prisma.medication.findMany).mockResolvedValue([
      {
        id: "med-ramipril",
        schedules: [
          {
            id: "sched-morgens",
            medicationId: "med-ramipril",
            windowStart: "07:00",
            windowEnd: "09:00",
            daysOfWeek: null,
          },
        ],
      },
    ] as never);
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockImplementation(((
      args: unknown,
    ) => {
      const a = args as {
        where: { OR?: unknown };
        select?: { id?: boolean };
      };
      if (a.where.OR) return Promise.resolve([]) as never;
      if (!a.select?.id) {
        // Existence probe — the projected slot already exists.
        return Promise.resolve([
          { medicationId: "med-ramipril", scheduledFor },
        ]) as never;
      }
      return Promise.resolve([
        { id: "e-existing", takenAt: null, skipped: false },
      ]) as never;
    }) as never);

    const res = await callGet(makeReq());
    expect(res.status).toBe(200);
    expect(prisma.medicationIntakeEvent.createMany).not.toHaveBeenCalled();
    const body = (await res.json()) as {
      data: { compliance: { scheduledToday: number; takenToday: number } };
    };
    expect(body.data.compliance.scheduledToday).toBe(1);
    // v1.4.48 L13 — suite-level `afterEach` restores real timers.
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
