import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// Every module is on for the aggregate assertions below; the gate's own
// behaviour (which cards a disabled module drops) is pinned in the sibling
// `module-gate.test.ts`.
vi.mock("@/lib/modules/gate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/modules/gate")>();
  return {
    ...actual,
    resolveModuleMap: vi.fn(async () =>
      Object.fromEntries(actual.MODULE_KEYS.map((k) => [k, true])),
    ),
  };
});

vi.mock("@/lib/db", () => ({
  prisma: {
    // v1.11.4 — `findMany` reads the raw per-stage SLEEP_DURATION rows for
    // the night-total sleep tile.
    measurement: { groupBy: vi.fn(), findMany: vi.fn() },
    medicationIntakeEvent: {
      findMany: vi.fn(),
      // v1.4.39 — the dashboard route now backfills
      // missing today-rows for daily schedules (parity with the
      // intake route's `expandTodayIntakes` projection) so the iOS
      // Dashboard compliance tile leaves "Heute nichts geplant" the
      // moment a daily med is configured.
      createMany: vi.fn(),
      // Shared meds-today builder — latest non-skipped intake per
      // medication (next-due re-anchor for rolling cadences).
      groupBy: vi.fn(),
    },
    medication: {
      // v1.4.39 — projection source for the today's-
      // intakes backfill.
      findMany: vi.fn(),
    },
    // Shared meds-today builder — current-era floor per medication.
    medicationScheduleRevision: {
      groupBy: vi.fn(),
    },
    // v1.17.0 — the sleep-rhythm block resolves the user's age-based sleep
    // need via the baseline profile (`User` row).
    user: {
      findUnique: vi.fn(),
    },
    // The greeting salutation is one of the two strings this route still
    // translates server-side; `resolveJobLocale` reads the operator's
    // configured default from here when the user's column is NULL.
    appSettings: {
      findUnique: vi.fn(async () => null),
    },
    // v1.4.38 — the route now uses `$queryRaw` for the per-type
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

// v1.11.4 — the route loads the user's source-priority ladder to collapse a
// dual-source sleep night; pin it to the defaults (null) so the test stays
// hermetic.
vi.mock("@/lib/rollups/measurement-read", () => ({
  loadUserSourcePriority: vi.fn(async () => null),
}));

// The mood card reads the canonical daily series; its own aggregation is
// covered by `src/lib/analytics/__tests__/mood-series.test.ts`. Pinned to an
// empty series by default so the legacy assertions keep their "no mood"
// expectation, and overridden per test below.
vi.mock("@/lib/dashboard/summary-reads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dashboard/summary-reads")>()),
  readAllTimeCounts: vi.fn(),
}));

vi.mock("@/lib/analytics/mood-series", () => ({
  buildMoodDailySeries: vi.fn(async () => ({
    entries: [],
    summary: null,
    entryCount: 0,
    source: "live" as const,
  })),
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
import { buildMoodDailySeries } from "@/lib/analytics/mood-series";
import { userDayKey } from "@/lib/tz/format";
import { readAllTimeCounts } from "@/lib/dashboard/summary-reads";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: {
    id: "user-1",
    username: "testuser",
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
  // v1.4.38 — three `$queryRaw` invocations land inside the
  // Promise.all in the order [latest7d, sparkline, streakDays]. The
  // analytics-cache wrap is also process-local, so we must reset it
  // between tests to keep cross-test isolation.
  __resetAllCachesForTests();
  vi.mocked(prisma.$queryRaw).mockResolvedValue([] as never);
  // The per-type all-time counts (`readAllTimeCounts`). Default to none so
  // legacy tests keep their "no data" expectations; the newest reading per
  // type, which `lastSeenAt` carries, comes from the latest-reading read.
  vi.mocked(readAllTimeCounts).mockResolvedValue([] as never);
  // v1.11.4 — the sleep tile reads the raw per-stage SLEEP_DURATION rows
  // via `measurement.findMany` to reconstruct the night total. Default to
  // no rows so legacy tests keep their "no sleep" expectation.
  vi.mocked(prisma.measurement.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
    [] as never,
  );
  // v1.4.39 — default the projection prisma reads to
  // "no active medications" so the legacy tests stay in their original
  // branch (empty today bucket, no backfill firing).
  vi.mocked(prisma.medication.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.medicationIntakeEvent.createMany).mockResolvedValue({
    count: 0,
  } as never);
  // Shared meds-today builder feeder reads — default to empty so the
  // legacy tests keep their "no medications" branch.
  vi.mocked(prisma.medicationIntakeEvent.groupBy).mockResolvedValue(
    [] as never,
  );
  vi.mocked(prisma.medicationScheduleRevision.groupBy).mockResolvedValue(
    [] as never,
  );
  // v1.17.0 — baseline profile read for the sleep-rhythm need. Default to a
  // 40-year-old adult (need = 420 min) so the rhythm block resolves.
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    dateOfBirth: new Date("1986-01-01"),
    gender: null,
    heightCm: null,
  } as never);
});

// v1.4.48 — restore real timers no matter how a test exits. A failed
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
    expect(body.data.greeting.salutation).toBe("Hi, testuser");
    expect(body.data.streak.currentDays).toBe(0);
    expect(body.data.compliance.scheduledToday).toBe(0);
    // REG-11 (v1.4.44): weight is the only always-emitted base metric.
    // BP + pulse + bodyFat + optional kinds gate on `latest ||
    // allTimeCount > 0` so accounts that have never logged a kind don't
    // get an empty placeholder tile.
    expect(body.data.metrics).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "weight" })]),
    );
    // v1.5.x — wire shape carries i18n keys, not translated strings.
    // The previous shape emitted "Gewicht" / "kg" / "Schritte" verbatim,
    // which injected DE into an English iOS UI.
    const weightCard = body.data.metrics.find((m) => m.id === "weight") as
      { titleKey: string; unitKey: string } | undefined;
    expect(weightCard?.titleKey).toBe("dashboard.metric.title.weight");
    expect(weightCard?.unitKey).toBe("dashboard.metric.unit.weight");
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

  it("surfaces lastSeenAt from the newest reading even when the 7-day window is empty", async () => {
    // Power-user path — the user has logged weight for years but
    // hasn't touched the app in two weeks. The all-time count and the
    // newest reading come back; the sparkline is empty. The route should
    // still emit the weight card
    // with the historical `lastSeenAt` so the iOS client renders the
    // staleness caption.
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const twoWeeksAgo = new Date(Date.now() - 14 * 86_400_000);
    vi.mocked(readAllTimeCounts).mockResolvedValue([
      {
        type: "WEIGHT",
        count: 312,
      },
    ] as never);
    // The newest reading, which `lastSeenAt` carries (first `$queryRaw` of
    // the round: the latest-reading read).
    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([
      { type: "WEIGHT", value: 81.2, measured_at: twoWeeksAgo },
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
    // The tile shows the historical reading (REG-11) and dates it, so the
    // iOS client builds the relative-age caption from one field.
    expect(weight?.latestValue).toBe(81.2);
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
    vi.mocked(readAllTimeCounts).mockResolvedValue([
      {
        type: "BLOOD_PRESSURE_SYS",
        count: 14,
      },
      {
        type: "BLOOD_PRESSURE_DIA",
        count: 14,
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
    expect(
      bp,
      "bp tile must be emitted for stale-but-valid history",
    ).toBeDefined();
    expect(bp?.latestValue).toBe(132);
    expect(bp?.secondaryValue).toBe(84);
    expect(bp?.allTimeCount).toBe(28);
    expect(bp?.lastSeenAt).toBe(sixtyDaysAgo.toISOString());
    expect(bp?.sparkline).toEqual([130, 132]);
    // v1.43 (ios #116 item 3) — a 40-year-old's age band is 120–129: the
    // sparkline's mean sits above it, so the rise is a setback.
    const judged = bp as unknown as {
      direction: unknown;
      trendSentiment: string;
    };
    expect(judged.direction).toEqual({
      direction: "up-bad",
      targetPosition: "above",
      basis: "profile_default",
    });
    expect(judged.trendSentiment).toBe("negative");
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
    vi.mocked(readAllTimeCounts).mockResolvedValue([
      {
        type: "WEIGHT",
        count: 200,
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
    vi.mocked(readAllTimeCounts).mockResolvedValue([
      {
        type: "PULSE",
        count: 42,
      },
    ] as never);
    vi.mocked(prisma.$queryRaw)
      .mockResolvedValueOnce([
        { type: "PULSE", value: 71, measured_at: days(30) },
      ] as never)
      .mockResolvedValueOnce([
        {
          type: "PULSE",
          bucket_start: days(36),
          mean: 68,
          count: 3,
          sum_value: null,
        },
        {
          type: "PULSE",
          bucket_start: days(35),
          mean: 70,
          count: 3,
          sum_value: null,
        },
        {
          type: "PULSE",
          bucket_start: days(34),
          mean: 69,
          count: 3,
          sum_value: null,
        },
        {
          type: "PULSE",
          bucket_start: days(33),
          mean: 71,
          count: 3,
          sum_value: null,
        },
        {
          type: "PULSE",
          bucket_start: days(32),
          mean: 73,
          count: 3,
          sum_value: null,
        },
        {
          type: "PULSE",
          bucket_start: days(31),
          mean: 72,
          count: 3,
          sum_value: null,
        },
        {
          type: "PULSE",
          bucket_start: days(30),
          mean: 71,
          count: 3,
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
    vi.mocked(readAllTimeCounts).mockResolvedValue([
      {
        type: "BLOOD_GLUCOSE",
        count: 4,
      },
    ] as never);
    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([
      { type: "BLOOD_GLUCOSE", value: 104, measured_at: tenDaysAgo },
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

  it("emits the sleep tile as the night TIME-ASLEEP total in hours, not one stage (v1.11.4)", async () => {
    // SLEEP_DURATION is stored one row per STAGE per night (minutes). The
    // tile must SUM the asleep stages of the latest night and convert to
    // hours, NOT surface a single stage. Excludes IN_BED + AWAKE.
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const wake = new Date("2026-06-04T06:00:00.000Z");
    vi.mocked(readAllTimeCounts).mockResolvedValue([
      {
        type: "SLEEP_DURATION",
        count: 5,
      },
    ] as never);
    // Raw per-stage rows for the night (the sleep findMany read).
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      {
        value: 480,
        measuredAt: new Date("2026-06-03T23:00:00.000Z"),
        sleepStage: "IN_BED",
      },
      {
        value: 240,
        measuredAt: new Date("2026-06-04T00:00:00.000Z"),
        sleepStage: "CORE",
      },
      {
        value: 90,
        measuredAt: new Date("2026-06-04T02:00:00.000Z"),
        sleepStage: "DEEP",
      },
      {
        value: 80,
        measuredAt: new Date("2026-06-04T04:00:00.000Z"),
        sleepStage: "REM",
      },
      { value: 20, measuredAt: wake, sleepStage: "AWAKE" },
    ] as never);
    const res = await callGet(makeReq());
    const body = (await res.json()) as {
      data: {
        metrics: Array<{
          id: string;
          latestValue: number | null;
          unit: string | null;
          sleepStages: Record<string, number> | null;
          sleepSourceDiscrepancy: {
            deltaMinutes: number;
            sources: Array<{
              source: string;
              deviceType: string | null;
              asleepMinutes: number;
            }>;
          } | null;
        }>;
      };
    };
    const sleep = body.data.metrics.find((m) => m.id === "sleep");
    expect(sleep, "sleep tile must be emitted").toBeDefined();
    // Time asleep = CORE + DEEP + REM = 240 + 90 + 80 = 410 min → 6.83 h.
    // (IN_BED 480 + AWAKE 20 excluded.)
    expect(sleep?.latestValue).toBeCloseTo(410 / 60, 2);
    expect(sleep?.unit).toBe("h");
    // Stage breakdown is exposed in hours for a future detail view.
    expect(sleep?.sleepStages?.CORE).toBeCloseTo(4, 2);
    expect(sleep?.sleepStages?.DEEP).toBeCloseTo(1.5, 2);
    expect(sleep?.sleepStages?.REM).toBeCloseTo(80 / 60, 2);
    // v1.28.x — the additive discrepancy field is present and null-safe:
    // source-less single-writer rows carry no annotation.
    expect(sleep?.sleepSourceDiscrepancy).toBeNull();
    // Every non-sleep kind pins the additive field to null.
    for (const m of body.data.metrics) {
      if (m.id !== "sleep") expect(m.sleepSourceDiscrepancy).toBeNull();
    }
  });

  it("carries the latest night's source-discrepancy annotation on the sleep tile (v1.28.x)", async () => {
    // Two writers disagree on the night: granular Apple (410 asleep) next
    // to a bare Withings aggregate claiming 615. Apple wins the served
    // total; the additive annotation surfaces the disagreement.
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const wake = new Date("2026-06-04T06:00:00.000Z");
    vi.mocked(readAllTimeCounts).mockResolvedValue([
      {
        type: "SLEEP_DURATION",
        count: 4,
      },
    ] as never);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      {
        value: 240,
        measuredAt: new Date("2026-06-04T00:00:00.000Z"),
        sleepStage: "CORE",
        source: "APPLE_HEALTH",
      },
      {
        value: 90,
        measuredAt: new Date("2026-06-04T02:00:00.000Z"),
        sleepStage: "DEEP",
        source: "APPLE_HEALTH",
      },
      {
        value: 80,
        measuredAt: new Date("2026-06-04T04:00:00.000Z"),
        sleepStage: "REM",
        source: "APPLE_HEALTH",
      },
      {
        value: 615,
        measuredAt: wake,
        sleepStage: "ASLEEP",
        source: "WITHINGS",
      },
    ] as never);
    const res = await callGet(makeReq());
    const body = (await res.json()) as {
      data: {
        metrics: Array<{
          id: string;
          latestValue: number | null;
          sleepSourceDiscrepancy: {
            deltaMinutes: number;
            sources: Array<{
              source: string;
              deviceType: string | null;
              asleepMinutes: number;
            }>;
          } | null;
        }>;
      };
    };
    const sleep = body.data.metrics.find((m) => m.id === "sleep");
    expect(sleep, "sleep tile must be emitted").toBeDefined();
    // Served total stays the winning writer's number (410 min → 6.83 h).
    expect(sleep?.latestValue).toBeCloseTo(410 / 60, 2);
    expect(sleep?.sleepSourceDiscrepancy).toEqual({
      deltaMinutes: 205,
      sources: [
        { source: "WITHINGS", deviceType: null, asleepMinutes: 615 },
        { source: "APPLE_HEALTH", deviceType: null, asleepMinutes: 410 },
      ],
    });
  });

  it("emits the sleep-rhythm DTO (sleep-debt + chronotype) computed from the foundation modules (v1.17.0)", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    // Ten consecutive 6 h (360 min) nights. Need = 420 (40-year-old default in
    // beforeEach) → a 60-min deficit per night, 10 nights ≥ the night floor.
    const rows = [];
    for (let d = 1; d <= 10; d++) {
      const day = String(d).padStart(2, "0");
      rows.push({
        value: 360,
        measuredAt: new Date(`2026-06-${day}T06:00:00.000Z`),
        sleepStage: "ASLEEP",
        source: "APPLE_HEALTH",
        deviceType: null,
      });
    }
    vi.mocked(prisma.measurement.findMany).mockResolvedValue(rows as never);

    const res = await callGet(makeReq());
    const body = (await res.json()) as {
      data: {
        sleepRhythm: {
          sleepDebt: {
            state: string;
            debtMinutes: number;
            needMinutes: number;
            nightsCounted: number;
            windowNights: number;
            nightsUntilReady: number;
          };
          chronotype: {
            state: string;
            freeNightsCounted: number;
            workNightsCounted: number;
            freeNightsUntilReady: number;
          };
        };
      };
    };
    const { sleepDebt, chronotype } = body.data.sleepRhythm;
    // Debt DTO is the computeSleepDebt result: the rolling balance over the
    // 5-night window of 60-min-short nights with no surplus to recover →
    // 5 × 60 = 300 min, need forwarded as 420 — proves the route reused the
    // module, not a recompute.
    expect(sleepDebt.state).toBe("ready");
    expect(sleepDebt.debtMinutes).toBe(300);
    expect(sleepDebt.needMinutes).toBe(420);
    expect(sleepDebt.nightsCounted).toBe(5);
    expect(sleepDebt.windowNights).toBe(5);
    expect(sleepDebt.nightsUntilReady).toBe(0);
    // Chronotype DTO carries every wiring field; the calm learning state holds
    // until enough free-day nights exist (these are all weekday wake days).
    expect(chronotype.state).toBe("learning");
    expect(typeof chronotype.freeNightsCounted).toBe("number");
    expect(typeof chronotype.freeNightsUntilReady).toBe("number");
  });

  it("paints the steps sparkline from rollup sum_value, not mean (v1.4.39 W-SUM)", async () => {
    // The ACTIVITY_STEPS tile renders the per-day SUM, not the
    // per-bucket MEAN. The sparkline query feeds the SQL aggregate
    // directly off the `measurement_rollups` row; pinning the
    // returned shape proves the route hands `sum_value` through
    // instead of reconstructing from `mean * count`.
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(readAllTimeCounts).mockResolvedValue([
      {
        type: "ACTIVITY_STEPS",
        count: 7,
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
    vi.mocked(readAllTimeCounts).mockResolvedValue([
      {
        type: "ACTIVITY_STEPS",
        count: 7,
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
        startsOn: null,
        endsOn: null,
        oneShot: false,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        schedules: [
          {
            id: "sched-morgens",
            medicationId: "med-ramipril",
            windowStart: "07:00",
            windowEnd: "09:00",
            daysOfWeek: null,
            timesOfDay: [],
            reminderGraceMinutes: null,
            rrule: null,
            rollingIntervalDays: null,
          },
        ],
      },
    ] as never);
    // The shared meds-today builder issues four findMany shapes:
    //   1. projector existence probe (no `OR`, selects medicationId +
    //      scheduledFor) → empty (no rows yet)
    //   2. today tally read after backfill (no `OR`, selects takenAt +
    //      skipped) → one minted row
    //   3. resolved-slot read + streak fetch (with `OR`) → empty
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockImplementation(((
      args: unknown,
    ) => {
      const a = args as {
        where: { OR?: unknown };
        select?: { medicationId?: boolean };
      };
      if (a.where.OR) return Promise.resolve([]) as never;
      // The existence probe asks for `(medicationId, scheduledFor)`;
      // the tally read asks for `(takenAt, skipped)`.
      if (a.select?.medicationId) return Promise.resolve([]) as never;
      return Promise.resolve([
        {
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

  it("projects one row per timesOfDay for a twice-daily schedule", async () => {
    // A single MedicationSchedule row carrying two first-class
    // `timesOfDay` is two distinct dose slots per day. Pre-fix the
    // projector minted only the `windowStart` slot, so the second daily
    // dose never appeared in the today-tile and the event-count
    // compliance rollup read half the expected doses (a 2×/day med
    // showed 50%). Assert the backfill mints both slots.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-21T03:00:00.000Z"));
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medication.findMany).mockResolvedValue([
      {
        id: "med-twice-daily",
        startsOn: null,
        endsOn: null,
        oneShot: false,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        schedules: [
          {
            id: "sched-bid",
            medicationId: "med-twice-daily",
            windowStart: "07:00",
            windowEnd: "07:30",
            daysOfWeek: null,
            timesOfDay: ["07:00", "19:00"],
            reminderGraceMinutes: null,
            rrule: null,
            rollingIntervalDays: null,
          },
        ],
      },
    ] as never);
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
      [] as never,
    );
    vi.mocked(prisma.medicationIntakeEvent.createMany).mockResolvedValue({
      count: 2,
    } as never);

    const res = await callGet(makeReq());
    expect(res.status).toBe(200);
    expect(prisma.medicationIntakeEvent.createMany).toHaveBeenCalledTimes(1);
    const args = vi.mocked(prisma.medicationIntakeEvent.createMany).mock
      .calls[0][0] as {
      data: Array<{ medicationId: string; scheduledFor: Date }>;
    };
    expect(args.data).toHaveLength(2);
    const hours = args.data
      .map((r) => new Date(r.scheduledFor).getUTCHours())
      .sort((a, b) => a - b);
    // 07:00 and 19:00 in the default zone (Europe/Berlin, UTC+2 in May)
    // materialise to 05:00 and 17:00 UTC. The assertion that matters is
    // two distinct slots, not one.
    expect(hours).toEqual([5, 17]);
    vi.useRealTimers();
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
        startsOn: null,
        endsOn: null,
        oneShot: false,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        schedules: [
          {
            id: "sched-morgens",
            medicationId: "med-ramipril",
            windowStart: "07:00",
            windowEnd: "09:00",
            daysOfWeek: null,
            timesOfDay: [],
            reminderGraceMinutes: null,
            rrule: null,
            rollingIntervalDays: null,
          },
        ],
      },
    ] as never);
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockImplementation(((
      args: unknown,
    ) => {
      const a = args as {
        where: { OR?: unknown };
        select?: { medicationId?: boolean };
      };
      if (a.where.OR) return Promise.resolve([]) as never;
      if (a.select?.medicationId) {
        // Existence probe — the projected slot already exists.
        return Promise.resolve([
          { medicationId: "med-ramipril", scheduledFor },
        ]) as never;
      }
      // Today tally read — the pre-existing pending row.
      return Promise.resolve([{ takenAt: null, skipped: false }]) as never;
    }) as never);

    const res = await callGet(makeReq());
    expect(res.status).toBe(200);
    expect(prisma.medicationIntakeEvent.createMany).not.toHaveBeenCalled();
    const body = (await res.json()) as {
      data: { compliance: { scheduledToday: number; takenToday: number } };
    };
    expect(body.data.compliance.scheduledToday).toBe(1);
    // v1.4.48 — suite-level `afterEach` restores real timers.
  });

  it("computes intake compliance for today", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    // No active medications (default) → the projector early-outs, so
    // the only no-`OR` read is the meds-today tally over the window.
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockImplementation(((
      args: unknown,
    ) => {
      const a = args as { where: { OR?: unknown } };
      if (!a.where.OR) {
        return Promise.resolve([
          { takenAt: new Date(), skipped: false },
          { takenAt: null, skipped: false },
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

/**
 * Mood + BMI cards.
 *
 * Both metrics existed in the record but the summary payload emitted
 * neither, so the native home screen could not render those two tiles while
 * every other tile worked. Both are resolved server-side from the canonical
 * source — `buildMoodDailySeries` for mood, `computeBmi` for BMI — so the
 * client consumes a finished figure instead of re-deriving one.
 */
describe("GET /api/dashboard/summary — greeting locale", () => {
  // The salutation and the streak label are translated on the server, and
  // the native client is this route's only caller: a Bearer request carries
  // no locale cookie, so `User.locale` is the sole per-user signal. When it
  // is NULL the operator's configured default is the answer — the same
  // fallback order every background writer uses. The coercion this replaces
  // stopped at English, so a German instance greeted a user who never opened
  // the language picker in English while the rest of their screen was German.
  it("falls back to the operator default, not to English", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
      defaultLocale: "de",
    } as never);

    const res = await callGet(makeReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { greeting: { salutation: string } };
    };
    expect(body.data.greeting.salutation).toBe("Hallo, testuser");
  });

  it("still prefers the user's own stored locale", async () => {
    vi.mocked(getSession).mockResolvedValue({
      ...SESSION_OK,
      user: { ...SESSION_OK.user, locale: "en" },
    } as never);
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
      defaultLocale: "de",
    } as never);

    const res = await callGet(makeReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { greeting: { salutation: string } };
    };
    expect(body.data.greeting.salutation).toBe("Hi, testuser");
  });
});

describe("GET /api/dashboard/summary — mood + BMI cards", () => {
  function cardsOf(body: unknown): Array<Record<string, unknown>> {
    return (body as { data: { metrics: Array<Record<string, unknown>> } }).data
      .metrics;
  }

  it("emits a mood card from the canonical daily series", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(buildMoodDailySeries).mockResolvedValue({
      entries: [
        { date: "2026-07-01", score: 2, samples: 1 },
        { date: "2026-07-02", score: 3, samples: 2 },
        { date: "2026-07-03", score: 4.5, samples: 1 },
      ],
      summary: null,
      entryCount: 3,
      source: "rollup",
    } as never);

    const res = await callGet(makeReq());
    expect(res.status).toBe(200);
    const mood = cardsOf(await res.json()).find((c) => c.kind === "mood");

    expect(mood).toBeDefined();
    // Headline is the newest day's score, verbatim from the series — the
    // route must not re-average or re-round what the helper resolved.
    expect(mood?.latestValue).toBe(4.5);
    expect(mood?.sparkline).toEqual([2, 3, 4.5]);
    expect(mood?.trend).toBe("up");
    expect(mood?.allTimeCount).toBe(3);
    expect(mood?.titleKey).toBe("dashboard.metric.title.mood");
    expect(mood?.unitKey).toBe("dashboard.metric.unit.mood");
    // The day key is the account's local day (default zone, summer time):
    // its first instant, not the key written out as UTC midnight.
    expect(mood?.lastSeenAt).toBe("2026-07-02T22:00:00.000Z");
    expect(mood?.updatedAt).toBe("2026-07-02T22:00:00.000Z");
  });

  it("puts the mood instant on the logged day for a zone west of UTC", async () => {
    // The day key as UTC midnight is the previous evening in Los Angeles,
    // so a client formatting the instant in its own zone showed today's
    // entry as yesterday's.
    vi.mocked(getSession).mockResolvedValue({
      ...SESSION_OK,
      user: { ...SESSION_OK.user, timezone: "America/Los_Angeles" },
    } as never);
    vi.mocked(buildMoodDailySeries).mockResolvedValue({
      entries: [{ date: "2026-07-03", score: 4, samples: 1 }],
      summary: null,
      entryCount: 1,
      source: "rollup",
    } as never);

    const res = await callGet(makeReq());
    const mood = cardsOf(await res.json()).find((c) => c.kind === "mood");
    const at = new Date(mood?.updatedAt as string);
    expect(userDayKey(at, "America/Los_Angeles")).toBe("2026-07-03");
    expect(mood?.updatedAt).toBe("2026-07-03T07:00:00.000Z");
  });

  it("omits the mood card when the account has never logged a mood", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await callGet(makeReq());
    expect(res.status).toBe(200);
    expect(cardsOf(await res.json()).find((c) => c.kind === "mood")).toBe(
      undefined,
    );
  });

  it("emits a BMI card computed from the profile height and latest weight", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    // 180 cm profile.
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      dateOfBirth: new Date("1986-01-01"),
      gender: null,
      heightCm: 180,
    } as never);
    // `computeBmi` reads recent weight rows through `measurement.findMany`.
    // 81 kg at 1.80 m => 25.0.
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      { value: 81, measuredAt: new Date("2026-07-03T08:00:00.000Z") },
    ] as never);

    const res = await callGet(makeReq());
    expect(res.status).toBe(200);
    const bmi = cardsOf(await res.json()).find((c) => c.kind === "bmi");

    expect(bmi).toBeDefined();
    // The canonical helper's rounding (1 dp), not a second formula.
    expect(bmi?.latestValue).toBe(25);
    expect(bmi?.titleKey).toBe("dashboard.metric.title.bmi");
    expect(bmi?.unitKey).toBe("dashboard.metric.unit.bmi");
  });

  it("omits the BMI card when the profile carries no height", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    // Default profile has `heightCm: null`; weight alone cannot yield a BMI.
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      { value: 81, measuredAt: new Date("2026-07-03T08:00:00.000Z") },
    ] as never);

    const res = await callGet(makeReq());
    expect(res.status).toBe(200);
    expect(cardsOf(await res.json()).find((c) => c.kind === "bmi")).toBe(
      undefined,
    );
  });
});
