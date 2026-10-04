/**
 * A history the retrieval window cannot reach is not an absent metric (#648).
 *
 * The reported case is the fixture: a substantial glucose history imported from
 * a fortnight in April 2024, on an account whose glucose surfaces display it
 * correctly, asked about through the Coach. Every assertion here exists to keep
 * the two situations distinguishable end to end — the tool result, the DATA
 * INVENTORY line the model reads before it decides whether to fetch at all, and
 * the two instructions that used to tell it to report absence and move on.
 *
 * Dates are fixed and `now` is injected, so the fixture cannot slide out of its
 * window as the calendar moves.
 */
import { DEFAULT_UNIT_PREFERENCES } from "@/lib/measurements/display-transform";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import type { CoachSnapshotResult } from "@/lib/ai/coach/snapshot";

const buildCoachSnapshot =
  vi.fn<(userId: string, scope?: unknown) => Promise<CoachSnapshotResult>>();
vi.mock("@/lib/ai/coach/snapshot", () => ({
  buildCoachSnapshot: (userId: string, scope?: unknown) =>
    buildCoachSnapshot(userId, scope),
}));

vi.mock("@/lib/ai/coach/tools/correlations-read", () => ({
  readCoachCorrelations: () => Promise.resolve({ present: false }),
}));
vi.mock("@/lib/ai/coach/illness-snapshot", () => ({
  buildIllnessScores: () => Promise.resolve(null),
}));
vi.mock("@/lib/cycle/gate", () => ({
  isCycleAvailableForUser: () => Promise.resolve(false),
}));

// The probe is the point of the fix, so it runs for real against a stubbed
// Prisma. Every aggregate the probe can issue is scripted here.
interface GroupRow {
  type: string;
  unit: string | null;
  _count: { _all: number };
  _min: { measuredAt: Date | null; value: number | null };
  _max: { measuredAt: Date | null; value: number | null };
  _avg: { value: number | null };
}
let measurementRows: GroupRow[] = [];
let measurementThrows = false;
/** What the day-weighted pulse query returns, per `type|unit`. */
let pulseDayMeans: Array<{ type: string; unit: string | null; mean: number }> =
  [];
const workoutAggregate = vi.fn();
const moodAggregate = vi.fn();
const intakeAggregate = vi.fn();
const labAggregate = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: {
      groupBy: (args: { where: { type: { in: string[] } } }) => {
        if (measurementThrows) {
          return Promise.reject(new Error("probe down"));
        }
        const wanted = new Set(args.where.type.in);
        return Promise.resolve(
          measurementRows.filter((r) => wanted.has(r.type)),
        );
      },
    },
    $queryRaw: () => Promise.resolve(pulseDayMeans),
    workout: { aggregate: (a: unknown) => workoutAggregate(a) },
    moodEntry: { aggregate: (a: unknown) => moodAggregate(a) },
    medicationIntakeEvent: { aggregate: (a: unknown) => intakeAggregate(a) },
    labResult: { aggregate: (a: unknown) => labAggregate(a) },
  },
}));

vi.mock("@/lib/tz/resolver", () => ({
  resolveUserTimezone: () => Promise.resolve("UTC"),
}));

import { executeCoachTool } from "@/lib/ai/coach/tools/executor";
import {
  buildCoachDataInventory,
  renderDataInventory,
} from "@/lib/ai/coach/tools/inventory";
import { buildToolModeAddendum } from "@/lib/ai/coach/tools/system-addendum";
import {
  classifyAvailability,
  probeCoachAvailability,
} from "@/lib/ai/coach/tools/availability";

/** The reported import: a fortnight of readings, well over a year old. */
const HISTORIC_GLUCOSE: GroupRow = {
  type: "BLOOD_GLUCOSE",
  unit: "mg/dL",
  _count: { _all: 1597 },
  _min: { measuredAt: new Date("2024-04-03T06:12:00Z"), value: 61 },
  _max: { measuredAt: new Date("2024-04-17T21:40:00Z"), value: 243 },
  _avg: { value: 118.4 },
};

/** A reading day inside the searched window, for the in-scope branch. */
function recentRow(type: string, daysAgo: number, now: Date): GroupRow {
  const at = new Date(now.getTime() - daysAgo * 86_400_000);
  return {
    type,
    unit: "bpm",
    _count: { _all: 42 },
    _min: { measuredAt: at, value: 52 },
    _max: { measuredAt: at, value: 71 },
    _avg: { value: 61 },
  };
}

const NOW = new Date("2026-07-26T09:00:00Z");

function snapshot(sections: Record<string, unknown>): CoachSnapshotResult {
  return {
    snapshotJson: JSON.stringify(sections),
    sections,
    provenance: { windows: [], metrics: [] },
    referenceGrounding: null,
    units: DEFAULT_UNIT_PREFERENCES,
  };
}

function emptyAggregate() {
  return {
    _count: { _all: 0 },
    _min: {
      startedAt: null,
      moodLoggedAt: null,
      scheduledFor: null,
      takenAt: null,
    },
    _max: {
      startedAt: null,
      moodLoggedAt: null,
      scheduledFor: null,
      takenAt: null,
    },
  };
}

beforeEach(() => {
  // The clock is pinned so the fixture cannot age out of its window: the
  // executor's probe reads `new Date()` (there is no request-scoped clock on
  // that path), and a relative-date fixture that drifts past 365 days would
  // start asserting the opposite of what it was written to prove.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  buildCoachSnapshot.mockReset();
  measurementRows = [];
  measurementThrows = false;
  for (const fn of [
    workoutAggregate,
    moodAggregate,
    intakeAggregate,
    labAggregate,
  ]) {
    fn.mockReset();
    fn.mockResolvedValue(emptyAggregate());
  }
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the reported case: a metric whose whole history is outside the window", () => {
  it("reports outside_window with the range and a bounded aggregate, NOT no_data", async () => {
    measurementRows = [HISTORIC_GLUCOSE];
    buildCoachSnapshot.mockResolvedValue(snapshot({}));

    const result = await executeCoachTool({
      userId: "u1",
      name: "get_glucose_panel",
      rawArguments: JSON.stringify({ window: "allTime" }),
    });

    expect(result.present).toBe(false);
    expect(result.reason).toBe("outside_window");
    expect(result.searchedWindow).toBe("allTime");
    expect(result.available).toMatchObject({
      count: 1597,
      firstDate: "2024-04-03",
      lastDate: "2024-04-17",
      // Older than any window reaches — so there is nothing to re-call with,
      // and the honest sentence is the whole answer.
      reachableWithWindow: null,
    });
    expect(result.available?.series).toEqual([
      {
        series: "BLOOD_GLUCOSE",
        unit: "mg/dL",
        count: 1597,
        mean: 118.4,
        min: 61,
        max: 243,
      },
    ]);
  });

  it("keeps a never-recorded metric distinguishable from the same run", async () => {
    measurementRows = [HISTORIC_GLUCOSE];
    buildCoachSnapshot.mockResolvedValue(snapshot({}));

    const historic = await executeCoachTool({
      userId: "u1",
      name: "get_glucose_panel",
      rawArguments: JSON.stringify({ window: "allTime" }),
    });
    const neverRecorded = await executeCoachTool({
      userId: "u1",
      name: "get_metric_series",
      rawArguments: JSON.stringify({ metric: "hrv", window: "allTime" }),
    });

    // Both are misses; they are NOT the same miss. Collapsing the two reasons
    // back into one literal is the defect, and this is the assertion that
    // catches it.
    expect(historic.present).toBe(false);
    expect(neverRecorded.present).toBe(false);
    expect(neverRecorded.reason).toBe("no_data");
    expect(neverRecorded.available).toBeUndefined();
    expect(historic.reason).not.toBe(neverRecorded.reason);
  });

  it("names the window to re-call with when one would reach the rows", async () => {
    measurementRows = [
      {
        type: "WEIGHT",
        unit: "kg",
        _count: { _all: 240 },
        _min: { measuredAt: new Date("2025-09-01T07:00:00Z"), value: 79.1 },
        _max: { measuredAt: new Date("2026-01-07T07:00:00Z"), value: 84.6 },
        _avg: { value: 82 },
      },
    ];
    buildCoachSnapshot.mockResolvedValue(snapshot({}));

    const result = await executeCoachTool({
      userId: "u1",
      name: "get_metric_series",
      rawArguments: JSON.stringify({ metric: "weight", window: "last30days" }),
    });

    expect(result.reason).toBe("outside_window");
    expect(result.available?.reachableWithWindow).toBe("lastYear");
  });

  it("does not call rows inside the window 'outside' it", async () => {
    measurementRows = [recentRow("PULSE", 2, NOW)];
    buildCoachSnapshot.mockResolvedValue(snapshot({}));

    const result = await executeCoachTool({
      userId: "u1",
      name: "get_metric_series",
      rawArguments: JSON.stringify({ metric: "pulse", window: "last30days" }),
    });

    // Rows exist, recent, and the domain still produced no block — a module is
    // off or a floor was not met. Widening would not help, and neither would
    // telling the person they have no pulse readings.
    expect(result.reason).toBe("unavailable_in_scope");
    expect(result.available?.count).toBe(42);
  });

  it("withholds a mean it cannot compute honestly across mixed units", async () => {
    measurementRows = [
      HISTORIC_GLUCOSE,
      {
        type: "BLOOD_GLUCOSE",
        unit: "mmol/L",
        _count: { _all: 120 },
        _min: { measuredAt: new Date("2024-03-01T06:00:00Z"), value: 3.9 },
        _max: { measuredAt: new Date("2024-03-20T21:00:00Z"), value: 12.1 },
        _avg: { value: 6.4 },
      },
    ];
    buildCoachSnapshot.mockResolvedValue(snapshot({}));

    const result = await executeCoachTool({
      userId: "u1",
      name: "get_glucose_panel",
      rawArguments: JSON.stringify({ window: "allTime" }),
    });

    expect(result.reason).toBe("outside_window");
    expect(result.available?.count).toBe(1717);
    expect(result.available?.firstDate).toBe("2024-03-01");
    expect(result.available?.series).toBeUndefined();
  });

  it("does not assert an absence it could not establish", async () => {
    measurementThrows = true;
    buildCoachSnapshot.mockResolvedValue(snapshot({}));

    const result = await executeCoachTool({
      userId: "u1",
      name: "get_glucose_panel",
      rawArguments: "{}",
    });

    expect(result.present).toBe(false);
    expect(result.reason).toBe("no_data_unconfirmed");
    expect(result.available).toBeUndefined();
  });

  it("probes the workouts domain against its own table, not Measurement", async () => {
    workoutAggregate.mockResolvedValue({
      _count: { _all: 88 },
      _min: { startedAt: new Date("2023-01-09T17:00:00Z") },
      _max: { startedAt: new Date("2023-11-30T18:30:00Z") },
    });
    buildCoachSnapshot.mockResolvedValue(snapshot({}));

    const result = await executeCoachTool({
      userId: "u1",
      name: "get_workouts",
      rawArguments: JSON.stringify({ window: "last90days" }),
    });

    expect(result.reason).toBe("outside_window");
    expect(result.available).toMatchObject({
      count: 88,
      firstDate: "2023-01-09",
      lastDate: "2023-11-30",
    });
    // No value column on a workout row, so no fabricated series aggregate.
    expect(result.available?.series).toBeUndefined();
  });

  it("leaves a derived domain's honest absence alone (nothing to probe)", async () => {
    buildCoachSnapshot.mockResolvedValue(snapshot({}));
    const result = await executeCoachTool({
      userId: "u1",
      name: "get_cycle",
      rawArguments: "{}",
    });
    expect(result.reason).toBe("no_data");
    expect(result.available).toBeUndefined();
  });
});

describe("no empty window read can bypass the probe again", () => {
  it("the executor returns no hand-written no_data for a missing section", () => {
    const source = readFileSync(
      join(process.cwd(), "src/lib/ai/coach/tools/executor.ts"),
      "utf8",
    );
    // Every miss goes through `emptyRead(...)`. A hand-written literal is how
    // the defect got in: four sites, one reason, two meanings.
    expect(source).not.toMatch(
      /return \{ present: false, reason: "no_data" \}/,
    );
    expect(source).not.toMatch(/reason: "no_data",\s*\}/);
  });
});

describe("classifyAvailability", () => {
  it("splits on whether the searched window already covered the rows", () => {
    const base = { count: 10, firstDate: "2024-01-01", lastDate: "2024-01-31" };
    expect(
      classifyAvailability({ ...base, reachableWithWindow: null }, "allTime"),
    ).toBe("outside_window");
    expect(
      classifyAvailability(
        { ...base, reachableWithWindow: "lastYear" },
        "last30days",
      ),
    ).toBe("outside_window");
    expect(
      classifyAvailability(
        { ...base, reachableWithWindow: "last7days" },
        "last30days",
      ),
    ).toBe("unavailable_in_scope");
    // `allTime` is capped at a year, so `lastYear` rows are already inside it.
    expect(
      classifyAvailability(
        { ...base, reachableWithWindow: "lastYear" },
        "allTime",
      ),
    ).toBe("unavailable_in_scope");
  });
});

describe("probeCoachAvailability", () => {
  // A pulse history's mean is the mean of its days, each the mean of its
  // hours' means; the reading AVG a workout's dense samples tip is not what
  // the Coach is told.
  it("states the day-weighted pulse mean, not the reading mean", async () => {
    measurementRows = [
      {
        type: "PULSE",
        unit: "bpm",
        _count: { _all: 930 },
        _min: { measuredAt: new Date("2026-07-20T00:05:00Z"), value: 60 },
        _max: { measuredAt: new Date("2026-07-20T23:55:00Z"), value: 150 },
        _avg: { value: 127.7 },
      },
    ];
    pulseDayMeans = [{ type: "PULSE", unit: "bpm", mean: 63.75 }];
    const probed = await probeCoachAvailability(
      "u1",
      new Map([["pulse", { kind: "measurement", types: ["PULSE"] }]]),
      { now: NOW },
    );
    pulseDayMeans = [];
    const series = [...probed.values()][0]?.series;
    expect(series).toEqual([
      expect.objectContaining({ series: "PULSE", mean: 63.8, count: 930 }),
    ]);
  });

  it("returns no entry for a domain the record is empty for", async () => {
    measurementRows = [];
    const probed = await probeCoachAvailability(
      "u1",
      new Map([["glucose", { kind: "measurement", types: ["BLOOD_GLUCOSE"] }]]),
      { now: NOW },
    );
    expect(probed.size).toBe(0);
  });

  it("merges the two blood-pressure series into one domain answer", async () => {
    measurementRows = [
      {
        type: "BLOOD_PRESSURE_SYS",
        unit: "mmHg",
        _count: { _all: 300 },
        _min: { measuredAt: new Date("2022-02-01T06:00:00Z"), value: 108 },
        _max: { measuredAt: new Date("2022-12-20T06:00:00Z"), value: 162 },
        _avg: { value: 131 },
      },
      {
        type: "BLOOD_PRESSURE_DIA",
        unit: "mmHg",
        _count: { _all: 298 },
        _min: { measuredAt: new Date("2022-02-03T06:00:00Z"), value: 64 },
        _max: { measuredAt: new Date("2022-12-19T06:00:00Z"), value: 101 },
        _avg: { value: 84 },
      },
    ];
    const probed = await probeCoachAvailability(
      "u1",
      new Map([
        [
          "bp",
          {
            kind: "measurement",
            types: ["BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA"],
          },
        ],
      ]),
      { now: NOW },
    );
    const bp = probed.get("bp");
    expect(bp?.count).toBe(598);
    expect(bp?.firstDate).toBe("2022-02-01");
    expect(bp?.lastDate).toBe("2022-12-20");
    // Two series, each with its own aggregate — never one merged mean.
    expect(bp?.series?.map((s) => s.series)).toEqual([
      "BLOOD_PRESSURE_SYS",
      "BLOOD_PRESSURE_DIA",
    ]);
  });
});

describe("DATA INVENTORY — the manifest the model reads before it fetches", () => {
  it("advertises the stored history instead of calling the domain absent", async () => {
    measurementRows = [HISTORIC_GLUCOSE];
    buildCoachSnapshot.mockResolvedValue(snapshot({}));

    const inventory = await buildCoachDataInventory("u1", {
      sources: [],
      window: "allTime",
    });
    const glucose = inventory.entries.find((e) => e.domain === "glucose");
    expect(glucose?.present).toBe(false);
    expect(glucose?.availability).toMatchObject({
      state: "outside_window",
      count: 1597,
      firstDate: "2024-04-03",
      lastDate: "2024-04-17",
      reachableWithWindow: null,
    });

    const rendered = renderDataInventory(inventory);
    expect(rendered).toContain("glucose: OUTSIDE WINDOW");
    expect(rendered).toContain("1597 readings, 2024-04-03 to 2024-04-17");
    // A metric the record genuinely lacks still reads plainly absent.
    expect(rendered).toMatch(/heart-rate variability: absent/);
  });

  it("leaves a genuinely empty account's manifest unchanged", async () => {
    measurementRows = [];
    buildCoachSnapshot.mockResolvedValue(snapshot({}));
    const inventory = await buildCoachDataInventory("u1", {
      sources: [],
      window: "last30days",
    });
    expect(inventory.entries.every((e) => e.availability === undefined)).toBe(
      true,
    );
    expect(renderDataInventory(inventory)).not.toContain("OUTSIDE WINDOW");
  });
});

describe("the two instructions that told the model to move on", () => {
  it("the inventory preamble no longer equates present:false with no data", () => {
    const rendered = renderDataInventory({
      entries: [],
      restMode: false,
      cycleEnabled: false,
      window: "last30days",
      probeScope: { sources: [] },
    });
    expect(rendered).not.toMatch(
      /say plainly you have no data for it and pivot/,
    );
    expect(rendered).toContain("outside window");
    expect(rendered).toContain("that is not absence");
  });

  for (const locale of ["en", "de"] as const) {
    it(`the tool-mode addendum (${locale}) branches on the reason code`, () => {
      const addendum = buildToolModeAddendum(locale);
      // The instruction that produced the report: one sentence covering every
      // present:false, telling the model to declare absence and move on.
      const oldPivotRule =
        locale === "en"
          ? /say plainly that you have no data for that metric and pivot/i
          : /sage klar, dass dazu keine Daten vorliegen, und lenke um/i;
      expect(addendum).not.toMatch(oldPivotRule);
      expect(addendum).toContain("outside_window");
      expect(addendum).toContain("no_data_unconfirmed");
      expect(addendum).toContain("unavailable_in_scope");
      expect(addendum).toContain("reachableWithWindow");
    });

    it(`the tool-mode addendum (${locale}) forbids swapping the metric`, () => {
      const addendum = buildToolModeAddendum(locale);
      const forbids =
        locale === "en"
          ? /never answer a question about one metric by reporting a different one/i
          : /beantworte eine Frage zu einer Metrik niemals/i;
      expect(addendum).toMatch(forbids);
    });
  }
});

/**
 * The other half of the same missing distinction, from the builder side: three
 * cross-cutting narration blocks that failed to `null` indistinguishably from a
 * user who honestly has none. `signalTrust` is the block that tells the model how
 * much to trust the numbers it is about to narrate, so a silent failure means the
 * Coach reasons at full confidence over data it was supposed to caveat.
 *
 * Structural, because the builder's own reads are not drivable from a unit test:
 * the assertion is that no cross-cutting block swallows its failure into a bare
 * `null` any more.
 */
describe("a failed narration block is counted, not silently absent", () => {
  const source = readFileSync(
    join(process.cwd(), "src/lib/ai/coach/snapshot.ts"),
    "utf8",
  );

  it("routes every cross-cutting block failure through the annotator", () => {
    for (const block of [
      "adherenceStoryline",
      "changepoints",
      "signalTrust",
      "experimentOutcomes",
    ]) {
      expect(source, `${block} is not annotated on failure`).toContain(
        `blockFailed("${block}")`,
      );
    }
  });

  it("leaves no bare catch-to-null in the builder", () => {
    // The shape the finding named: a builder that throws becomes `null`, which
    // is byte-identical to a user who has nothing to report.
    expect(source).not.toContain(".catch(() => null)");
  });
});
