/**
 * v1.30.3 — `buildPeriodNarrativeContext` (the DB wrapper) must:
 *   - order its measurement read DESC + cap, resorting ASC before folding,
 *     so a dense account's cap falls on the OLDEST rows and never drops
 *     the CURRENT period (F2 — the asc+take(20000) cap used to drop the
 *     current period first, the worst possible direction for a
 *     current-vs-prior surface);
 *   - route every type through `buildMeasurementDailySeries`'s per-type
 *     grain (sleep = per-night SUM, cumulative = source-collapsed SUM),
 *     not the local `toDailyMeans` twin that used to blindly average
 *     every type including sleep-stage segments (F3).
 *
 * This exercises the real DB wrapper (mocked prisma), not just the pure
 * `assemblePeriodNarrativeContext` core the sibling test file covers.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const userFindUnique = vi.fn();
const measurementFindMany = vi.fn();
const moodFindMany = vi.fn();
// The wrapper takes its channel set from the shared discovery
// assembler, so the four channel families that used to be missing here (the
// dose-history ledger, the illness day-log, the daily weather rows, the opt-in
// custom metrics) are read on this path too. Default every one empty: this
// file is about the measurement read's ORDER and GRAIN, and an empty channel
// degrades to absent without touching either.
const medicationFindMany = vi.fn();
const intakeEventFindMany = vi.fn();
const illnessEpisodeFindMany = vi.fn();
const illnessDayLogFindMany = vi.fn();
const environmentContextFindMany = vi.fn();
const customMetricFindMany = vi.fn();
// The record's module map; every module on unless a test switches one off.
const moduleMap = vi.hoisted(() => ({ value: {} as Record<string, boolean> }));
vi.mock("@/lib/modules/gate", () => ({
  resolveModuleMap: vi.fn(async () => moduleMap.value),
}));

// The per-type measurement read is raw SQL; serve it from the findMany mock.
vi.mock("@/lib/measurements/newest-per-type", async () =>
  (
    await import("@/__tests__/helpers/newest-per-type-mock")
  ).newestPerTypeMock(),
);

vi.mock("@/lib/db", () => ({
  prisma: {
    // v1.44 — the extended channel families (intake, training, room climate).
    nutrientIntakeDay: { findMany: async () => [] },
    workout: { findMany: async () => [] },
    strainTrimpCache: { findMany: async () => [] },
    $queryRaw: async () => [],
    user: { findUnique: (a: unknown) => userFindUnique(a) },
    measurement: { findMany: (a: unknown) => measurementFindMany(a) },
    moodEntry: { findMany: (a: unknown) => moodFindMany(a) },
    medication: { findMany: (a: unknown) => medicationFindMany(a) },
    medicationIntakeEvent: { findMany: (a: unknown) => intakeEventFindMany(a) },
    illnessEpisode: { findMany: (a: unknown) => illnessEpisodeFindMany(a) },
    illnessDayLog: { findMany: (a: unknown) => illnessDayLogFindMany(a) },
    environmentContext: {
      findMany: (a: unknown) => environmentContextFindMany(a),
    },
    customMetric: { findMany: (a: unknown) => customMetricFindMany(a) },
    symptomDefinition: { findMany: async () => [] },
    dawarichDay: { findMany: async () => [] },
  },
}));

import { buildPeriodNarrativeContext } from "../period-narrative";

const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(() => {
  moduleMap.value = {};
  userFindUnique.mockReset().mockResolvedValue({
    timezone: "UTC",
    sourcePriorityJson: null,
  });
  measurementFindMany.mockReset();
  moodFindMany.mockReset().mockResolvedValue([]);
  medicationFindMany.mockReset().mockResolvedValue([]);
  intakeEventFindMany.mockReset().mockResolvedValue([]);
  illnessEpisodeFindMany.mockReset().mockResolvedValue([]);
  illnessDayLogFindMany.mockReset().mockResolvedValue([]);
  environmentContextFindMany.mockReset().mockResolvedValue([]);
  customMetricFindMany.mockReset().mockResolvedValue([]);
});

describe("buildPeriodNarrativeContext — grain (QA F3)", () => {
  it("never narrates a module that is switched off", async () => {
    // The fixture of the test above, with the sleep module off: the sleep
    // night is in the data, and the narrative must neither delta it nor scan
    // it. Mutation-checked against a caller passing an empty module map.
    moduleMap.value = { sleep: false };
    // `now` deep enough into the week that a full current + prior 7-day
    // span (plus the +1 day lag slack) has clean, unambiguous UTC days.
    const now = new Date("2026-06-30T12:00:00.000Z");

    // WEIGHT + PULSE: 14 daily readings each (current + prior week) so both
    // clear the >=3-covered-day floor and the >=2-metrics-covered gate.
    const dailyMetricRows: Array<{
      type: string;
      value: number;
      measuredAt: Date;
    }> = [];
    for (let i = 0; i < 14; i++) {
      const at = new Date(now.getTime() - i * DAY_MS - 6 * 60 * 60 * 1000);
      dailyMetricRows.push({ type: "WEIGHT", value: 80, measuredAt: at });
      dailyMetricRows.push({ type: "PULSE", value: 60, measuredAt: at });
    }

    // One night THIS week: CORE 240 + DEEP 90 + REM 80 = 410 minutes total
    // asleep. `measuredAt` is the END of each segment (reconstructor derives
    // the start from `measuredAt - value minutes`), matching
    // `sleep-night.test.ts` / `correlation-channel-series.test.ts`.
    const nightEnd = new Date(now.getTime() - 1 * DAY_MS);
    const sleepRows = [
      {
        type: "SLEEP_DURATION",
        value: 240,
        measuredAt: new Date(nightEnd.getTime() - 3 * 60 * 60 * 1000),
        source: "APPLE_HEALTH",
        deviceType: null,
        sleepStage: "CORE",
      },
      {
        type: "SLEEP_DURATION",
        value: 90,
        measuredAt: new Date(nightEnd.getTime() - 1.5 * 60 * 60 * 1000),
        source: "APPLE_HEALTH",
        deviceType: null,
        sleepStage: "DEEP",
      },
      {
        type: "SLEEP_DURATION",
        value: 80,
        measuredAt: nightEnd,
        source: "APPLE_HEALTH",
        deviceType: null,
        sleepStage: "REM",
      },
    ];

    measurementFindMany.mockResolvedValue([
      ...dailyMetricRows.map((r) => ({
        ...r,
        source: "MANUAL",
        deviceType: null,
        sleepStage: null,
      })),
      ...sleepRows,
    ]);

    const result = await buildPeriodNarrativeContext("u1", {
      period: "week",
      now,
      locale: "en",
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(
      result.metricDeltas.find((d) => d.type === "SLEEP_DURATION"),
    ).toBeUndefined();
    expect(result.metricDeltas.length).toBeGreaterThan(0);
  });

  it("sums a night's per-stage segments into the SLEEP_DURATION delta instead of averaging them", async () => {
    // `now` deep enough into the week that a full current + prior 7-day
    // span (plus the +1 day lag slack) has clean, unambiguous UTC days.
    const now = new Date("2026-06-30T12:00:00.000Z");

    // WEIGHT + PULSE: 14 daily readings each (current + prior week) so both
    // clear the >=3-covered-day floor and the >=2-metrics-covered gate.
    const dailyMetricRows: Array<{
      type: string;
      value: number;
      measuredAt: Date;
    }> = [];
    for (let i = 0; i < 14; i++) {
      const at = new Date(now.getTime() - i * DAY_MS - 6 * 60 * 60 * 1000);
      dailyMetricRows.push({ type: "WEIGHT", value: 80, measuredAt: at });
      dailyMetricRows.push({ type: "PULSE", value: 60, measuredAt: at });
    }

    // One night THIS week: CORE 240 + DEEP 90 + REM 80 = 410 minutes total
    // asleep. `measuredAt` is the END of each segment (reconstructor derives
    // the start from `measuredAt - value minutes`), matching
    // `sleep-night.test.ts` / `correlation-channel-series.test.ts`.
    const nightEnd = new Date(now.getTime() - 1 * DAY_MS);
    const sleepRows = [
      {
        type: "SLEEP_DURATION",
        value: 240,
        measuredAt: new Date(nightEnd.getTime() - 3 * 60 * 60 * 1000),
        source: "APPLE_HEALTH",
        deviceType: null,
        sleepStage: "CORE",
      },
      {
        type: "SLEEP_DURATION",
        value: 90,
        measuredAt: new Date(nightEnd.getTime() - 1.5 * 60 * 60 * 1000),
        source: "APPLE_HEALTH",
        deviceType: null,
        sleepStage: "DEEP",
      },
      {
        type: "SLEEP_DURATION",
        value: 80,
        measuredAt: nightEnd,
        source: "APPLE_HEALTH",
        deviceType: null,
        sleepStage: "REM",
      },
    ];

    measurementFindMany.mockResolvedValue([
      ...dailyMetricRows.map((r) => ({
        ...r,
        source: "MANUAL",
        deviceType: null,
        sleepStage: null,
      })),
      ...sleepRows,
    ]);

    const result = await buildPeriodNarrativeContext("u1", {
      period: "week",
      now,
      locale: "en",
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    const sleepDelta = result.metricDeltas.find(
      (d) => d.type === "SLEEP_DURATION",
    );
    expect(sleepDelta).toBeDefined();
    // The pre-fix local `toDailyMeans` twin would have averaged the three
    // segment durations: (240 + 90 + 80) / 3 ≈ 137 — a number with no
    // clinical meaning. The correct grain is the night's TOTAL (410 min),
    // narrated in the hours its unit names: this used to read "410 h".
    expect(sleepDelta!.unit).toBe("h");
    expect(sleepDelta!.current).toBe(6.83);
    expect(sleepDelta!.current).not.toBeCloseTo((240 + 90 + 80) / 3 / 60, 1);
  });

  it("orders the measurement read DESC + cap so the CURRENT period survives a capped window (QA F2)", async () => {
    const now = new Date("2026-06-30T12:00:00.000Z");
    measurementFindMany.mockResolvedValue([]);

    await buildPeriodNarrativeContext("u1", {
      period: "week",
      now,
      locale: "en",
    });

    expect(measurementFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: { measuredAt: "desc" },
        take: 20000,
      }),
    );
    // The mood read carries the same discipline, and it is the one that also
    // pulls the RATED-factor tag-links this surface admits.
    expect(moodFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: { moodLoggedAt: "desc" },
        take: 5000,
      }),
    );
  });

  // The narrative used to fold in only the measurement channels,
  // MOOD and the RATED mood factors: the compliance, symptom, environmental
  // and custom-metric families had arrived at the correlations route and never
  // reached this surface. Nothing explained the gap — the comment that looked
  // like it did was the same sentence a sibling file carried while doing the
  // opposite. It scans the shared matrix now.
  it("reads every discovery channel family, not just the measurement ones", async () => {
    const now = new Date("2026-06-30T12:00:00.000Z");
    measurementFindMany.mockResolvedValue([]);

    await buildPeriodNarrativeContext("u1", {
      period: "month",
      now,
      locale: "en",
    });

    expect(medicationFindMany).toHaveBeenCalledTimes(1);
    expect(illnessEpisodeFindMany).toHaveBeenCalledTimes(1);
    expect(environmentContextFindMany).toHaveBeenCalledTimes(1);
    expect(customMetricFindMany).toHaveBeenCalledTimes(1);
  });

  // The one declared divergence: this surface — and only this surface — admits
  // the user's RATED mood factors. See `includeMoodFactors` for why.
  it("pulls the RATED-factor tag-links the other three surfaces do not", async () => {
    const now = new Date("2026-06-30T12:00:00.000Z");
    measurementFindMany.mockResolvedValue([]);

    await buildPeriodNarrativeContext("u1", {
      period: "month",
      now,
      locale: "en",
    });

    const select = moodFindMany.mock.calls[0]?.[0]?.select as {
      tagLinks?: { where?: { moodTag?: { kind?: string } } };
    };
    expect(select.tagLinks?.where?.moodTag?.kind).toBe("RATED");
  });
});
