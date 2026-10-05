/**
 * A series read never answers "present" without numbers.
 *
 * Two layers: the condensing a requested block goes through when its own
 * read passes the prompt budget (`series-condense.ts`), and the executor,
 * which re-reads a block the turn's shared full-source build cut for its
 * prompt, refuses to hand on a block with no figure in it, and tells the
 * model where the rest of a long history is.
 */
import { DEFAULT_UNIT_PREFERENCES } from "@/lib/measurements/display-transform";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CoachSnapshotResult } from "@/lib/ai/coach/snapshot";
import {
  KEEP_DAILY_ROWS,
  KEEP_MONTHLY_ROWS,
  KEEP_SESSIONS,
  condenseSeriesBlock,
  isoWeekMonth,
  summariseDaily,
  weeklyToMonthly,
  type DailyPoint,
} from "@/lib/ai/coach/series-condense";

const buildCoachSnapshot =
  vi.fn<
    (
      userId: string,
      scope?: unknown,
      options?: unknown,
    ) => Promise<CoachSnapshotResult>
  >();
vi.mock("@/lib/ai/coach/snapshot", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  buildCoachSnapshot: (userId: string, scope?: unknown, options?: unknown) =>
    buildCoachSnapshot(userId, scope, options),
}));
const buildCoachSourceSnapshot = vi.fn();
vi.mock("@/lib/ai/coach/source-snapshot", () => ({
  buildCoachSourceSnapshot: (...a: unknown[]) => buildCoachSourceSnapshot(...a),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: {
      groupBy: () => Promise.resolve([]),
      findMany: () => Promise.resolve([]),
    },
  },
}));

import { executeCoachTool } from "@/lib/ai/coach/tools/executor";
import { buildToolModeAddendum } from "@/lib/ai/coach/tools/system-addendum";
import { UNBOUNDED_REACH } from "@/lib/ai/coach/history-reach";

function weeks(count: number, from = 2023, value = (i: number) => 20 + i / 10) {
  return Array.from({ length: count }, (_, i) => {
    const year = from + Math.floor(i / 52);
    const week = (i % 52) + 1;
    return {
      weekISO: `${year}-W${String(week).padStart(2, "0")}`,
      mean: Math.round(value(i) * 10) / 10,
      count: 7,
    };
  });
}

function recent(count: number, value = (i: number) => 30 + i) {
  return Array.from({ length: count }, (_, i) => ({
    date: `2026-09-${String(i + 1).padStart(2, "0")}`,
    weekday: "Mon",
    value: value(i),
  }));
}

/** `count` consecutive days from `start`, valued by `value(i)`. */
function days(
  count: number,
  start: string,
  value: (i: number) => number,
): DailyPoint[] {
  return Array.from({ length: count }, (_, i) => {
    const at = new Date(`${start}T00:00:00Z`);
    at.setUTCDate(at.getUTCDate() + i);
    return { date: at.toISOString().slice(0, 10), value: value(i) };
  });
}

describe("series-condense", () => {
  it("places an ISO week in the month of its Thursday", () => {
    expect(isoWeekMonth("2026-W01")).toBe("2026-01");
    expect(isoWeekMonth("2025-W01")).toBe("2025-01"); // Thu 2 Jan 2025
    expect(isoWeekMonth("2026-W53")).toBe("2026-12");
    expect(isoWeekMonth("2026-W05")).toBe("2026-01"); // Thu 29 Jan
    expect(isoWeekMonth("nope")).toBeNull();
  });

  it("folds weekly means into count-weighted monthly means", () => {
    expect(
      weeklyToMonthly([
        { weekISO: "2026-W01", mean: 10, count: 1 },
        { weekISO: "2026-W02", mean: 20, count: 3 },
        { weekISO: "2026-W06", mean: 5, count: 2 },
      ]),
    ).toEqual([
      { month: "2026-01", mean: 17.5, count: 4 },
      { month: "2026-02", mean: 5, count: 2 },
    ]);
  });

  it("summarises the daily values, each day weighing the same", () => {
    // A year at 20, then a fortnight at 30: the fortnight is 14 of 379 days.
    const year = days(379, "2025-09-01", (i) => (i < 365 ? 20 : 30));
    const summary = summariseDaily([...year].reverse());
    expect(summary).toEqual({
      from: "2025-09-01",
      to: "2026-09-14",
      days: 379,
      first: 20,
      last: 30,
      min: 20,
      max: 30,
      mean: 20.37,
      firstWeekMean: 20,
      latestWeekMean: 30,
      change: 10,
    });
    expect(summariseDaily([])).toBeNull();
  });

  it("compares the first and latest calendar week, not two single days", () => {
    // Noisy days: first day low, last day high, both weeks average 50.
    const series = days(60, "2026-01-01", (i) =>
      i === 0
        ? 40
        : i === 59
          ? 60
          : 50 + (i % 2 === 0 ? 1 : -1) * (i < 7 || i > 52 ? 0 : 3),
    );
    const summary = summariseDaily(series)!;
    expect(summary.first).toBe(40);
    expect(summary.last).toBe(60);
    expect(summary.firstWeekMean).toBe(48.57);
    expect(summary.latestWeekMean).toBe(51.43);
    expect(summary.change).toBe(2.86);
  });

  it("gives a block no summary without its daily values", () => {
    const block = {
      unit: "kg",
      timeline: { recent: recent(14), weekly: weeks(150) },
    };
    condenseSeriesBlock(block, 1, "fatMass");
    expect(block).not.toHaveProperty("summary");
  });

  it("keeps numbers through every step and names what it cut", () => {
    const block = {
      unit: "kg",
      timeline: { recent: recent(14), weekly: weeks(150) },
    };
    const daily = { value: days(1050, "2023-10-25", (i) => (2000 + i) / 100) };
    expect(condenseSeriesBlock(block, 1, "fatMass", daily)).toBe(true);
    expect(block.timeline.recent).toHaveLength(KEEP_DAILY_ROWS);
    expect(block.timeline.recent.at(-1)?.value).toBe(43);
    expect(condenseSeriesBlock(block, 2, "fatMass", daily)).toBe(true);
    expect(block.timeline).not.toHaveProperty("weekly");
    const monthly = (block.timeline as { monthly?: unknown[] }).monthly;
    expect(monthly!.length).toBeGreaterThan(30);
    expect(condenseSeriesBlock(block, 3, "fatMass", daily)).toBe(true);
    expect((block.timeline as { monthly?: unknown[] }).monthly).toHaveLength(
      KEEP_MONTHLY_ROWS,
    );
    // The summary is the daily values', whatever the block still holds.
    const summary = (block as { summary?: Record<string, unknown> }).summary;
    expect(summary).toMatchObject({
      from: "2023-10-25",
      days: 1050,
      first: 20,
      last: 30.49,
    });
    expect((block as { condensed?: string[] }).condensed).toEqual([
      `daily values: newest ${KEEP_DAILY_ROWS} days kept`,
      "weekly values folded into monthly values",
      `monthly values: newest ${KEEP_MONTHLY_ROWS} months kept`,
    ]);
  });

  it("summarises blood pressure per series", () => {
    const block = {
      timeline: {
        recent: [{ date: "2026-09-01", weekday: "Tue", sys: 121, dia: 79 }],
        weeklySys: [{ weekISO: "2026-W30", mean: 130, count: 4 }],
        weeklyDia: [{ weekISO: "2026-W30", mean: 85, count: 4 }],
      },
    };
    condenseSeriesBlock(block, 2, "bloodPressure", {
      sys: days(40, "2026-07-24", (i) => (i < 33 ? 130 : 121)),
      dia: days(40, "2026-07-24", (i) => (i < 33 ? 85 : 79)),
    });
    expect(block).toMatchObject({
      summary: {
        sys: { first: 130, last: 121, change: -9 },
        dia: { first: 85, last: 79, change: -6 },
      },
      timeline: {
        monthlySys: [{ month: "2026-07", mean: 130, count: 4 }],
        monthlyDia: [{ month: "2026-07", mean: 85, count: 4 }],
      },
    });
  });

  it("leaves a block without a timeline alone", () => {
    const block = { aggregate: { mean: 1 } };
    expect(condenseSeriesBlock(block, 1, "fatMass")).toBe(false);
    expect(block).toEqual({ aggregate: { mean: 1 } });
  });
});

function snapshot(
  sections: Record<string, unknown>,
  extra: Partial<CoachSnapshotResult> = {},
): CoachSnapshotResult {
  return {
    snapshotJson: JSON.stringify(sections),
    sections,
    provenance: { windows: [], metrics: [] },
    referenceGrounding: null,
    units: DEFAULT_UNIT_PREFERENCES,
    ...extra,
  };
}

const SHARED = { sources: ["weight", "fat_mass", "steps"], window: "allTime" };

function series(args: Record<string, unknown>) {
  return executeCoachTool({
    userId: "u1",
    name: "get_metric_series",
    rawArguments: JSON.stringify(args),
    fallbackWindow: "allTime",
    sharedScope: SHARED as never,
    reach: UNBOUNDED_REACH,
  });
}

const FAT_MASS = {
  unit: "kg",
  timeline: { recent: recent(14, () => 18.2), weekly: weeks(50) },
};

describe("get_metric_series inside a chat turn", () => {
  beforeEach(() => {
    buildCoachSnapshot.mockReset();
  });

  it("re-reads a block the shared build cut, from its own source", async () => {
    buildCoachSnapshot.mockImplementation(async (_u, scope) =>
      scope === SHARED
        ? snapshot(
            { fatMass: { omitted: "trimmed for prompt budget" } },
            { degradedBlocks: ["fatMass", "steps"] },
          )
        : snapshot(
            { fatMass: FAT_MASS },
            {
              provenance: {
                windows: [],
                metrics: ["fat_mass"],
                counts: { fat_mass: 1460 },
              },
            },
          ),
    );
    const result = await series({ metric: "fat_mass", window: "allTime" });
    expect(buildCoachSnapshot).toHaveBeenCalledTimes(2);
    expect(buildCoachSnapshot.mock.calls[1][1]).toEqual({
      sources: ["fat_mass"],
      window: "allTime",
    });
    expect(result.present).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.section).toEqual(FAT_MASS);
    expect(data.readings).toBe(1460);
    expect(data.coverage).toContain("call get_metric_table yourself");
    // The note says how the summary was taken, and claims no more.
    expect(data.coverage).toContain("daily values over the whole read");
    expect(data.coverage).toContain("latestWeekMean");
    expect(data.coverage).not.toContain("every point");
  });

  it("keeps the shared build when the block was not cut there", async () => {
    buildCoachSnapshot.mockResolvedValue(
      snapshot({ fatMass: FAT_MASS }, { degradedBlocks: ["steps"] }),
    );
    const result = await series({ metric: "fat_mass" });
    expect(buildCoachSnapshot).toHaveBeenCalledTimes(1);
    expect(result.present).toBe(true);
  });

  it("never answers present with a block that holds no figure", async () => {
    for (const empty of [
      { unit: "kg" },
      { omitted: "trimmed for prompt budget" },
      // The shape the budget pass really leaves: the unit and the freshness
      // stamp, whose `daysAgo` is a number but not a reading.
      {
        unit: "kg",
        asOf: { daysAgo: 3, isToday: false, currentForTodayClaims: false },
      },
    ]) {
      buildCoachSnapshot.mockReset();
      buildCoachSnapshot.mockResolvedValue(snapshot({ fatMass: empty }));
      const result = await series({ metric: "fat_mass", window: "last30days" });
      expect(result).toEqual({ present: false, reason: "retrieval_failed" });
    }
  });

  it("states no coverage note on a short window", async () => {
    buildCoachSnapshot.mockResolvedValue(snapshot({ fatMass: FAT_MASS }));
    const result = await series({ metric: "fat_mass", window: "last30days" });
    expect(result.data).not.toHaveProperty("coverage");
  });
});

describe("the tool-mode rules", () => {
  it.each(["en", "de"] as const)(
    "tell the model to fetch the table itself (%s)",
    (locale) => {
      const text = buildToolModeAddendum(locale);
      expect(text).toMatch(/^7\. .*get_metric_table/m);
      expect(text).toContain("summary");
    },
  );
});

describe("series-condense reads each block in its own fields", () => {
  it("sleep: nights carry minutes, so the summary ends on the latest night", () => {
    const block = {
      timeline: {
        recent: Array.from({ length: 14 }, (_, i) => ({
          date: `2026-09-${String(i + 10).padStart(2, "0")}`,
          weekday: "Mon",
          minutes: 400 + i,
          stages: { core: 200, deep: 80, rem: 90 },
        })),
        weekly: weeks(6, 2026, () => 320).map((w, i) => ({
          ...w,
          weekISO: `2026-W${30 + i}`,
        })),
      },
    };
    const nights = {
      value: [
        ...days(49, "2026-07-20", () => 320),
        ...days(14, "2026-09-10", (i) => 400 + i),
      ],
    };
    condenseSeriesBlock(block, 1, "sleep", nights);
    expect(block).toMatchObject({
      summary: { to: "2026-09-23", last: 413, days: 63 },
    });
    expect(block.timeline.recent).toHaveLength(KEEP_DAILY_ROWS);
    expect(block.timeline.recent.at(-1)).toMatchObject({ minutes: 413 });
    condenseSeriesBlock(block, 2, "sleep", nights);
    expect(
      (block.timeline as unknown as { monthly: unknown[] }).monthly,
    ).toEqual([
      { month: "2026-07", mean: 320, count: 14 },
      { month: "2026-08", mean: 320, count: 28 },
    ]);
  });

  it("adherence: rates fold weighted by doses, not by readings", () => {
    const block = {
      rate: 88,
      timeline: {
        recent: [
          { date: "2026-09-30", weekday: "Wed", rate: 1, taken: 2, total: 2 },
          { date: "2026-10-01", weekday: "Thu", rate: 0.5, taken: 1, total: 2 },
        ],
        weekly: [
          { weekISO: "2026-W36", rate: 1, taken: 2, total: 2 },
          { weekISO: "2026-W37", rate: 0.5, taken: 7, total: 14 },
        ],
      },
    };
    condenseSeriesBlock(block, 2, "compliance", {
      value: [
        { date: "2026-09-30", value: 1 },
        { date: "2026-10-01", value: 0.5 },
      ],
    });
    expect(block).toMatchObject({
      summary: { to: "2026-10-01", last: 0.5 },
      timeline: { monthly: [{ month: "2026-09", rate: 0.56, total: 16 }] },
    });
    expect(block.timeline).not.toHaveProperty("weekly");
  });

  it("glucose: each measurement context condenses on its own", () => {
    const ctx = (base: number) => ({
      recent: recent(14, (i) => base + i),
      weekly: weeks(30, 2026, () => base),
    });
    const block = {
      unit: "mg/dL",
      panel: { tir: 0.8 },
      byContext: { FASTING: ctx(95), POST_MEAL: ctx(140) },
    };
    const daily = {
      FASTING: days(14, "2026-09-01", (i) => 95 + i),
      POST_MEAL: days(14, "2026-09-01", (i) => 140 + i),
    };
    expect(condenseSeriesBlock(block, 1, "glucose", daily)).toBe(true);
    expect(condenseSeriesBlock(block, 2, "glucose", daily)).toBe(true);
    expect(block).toMatchObject({
      summary: {
        FASTING: { last: 108, to: "2026-09-14" },
        POST_MEAL: { last: 153 },
      },
    });
    for (const c of Object.values(block.byContext)) {
      expect(c.recent).toHaveLength(KEEP_DAILY_ROWS);
      expect(c).not.toHaveProperty("weekly");
      expect((c as unknown as { monthly: unknown[] }).monthly.length).toBe(7);
    }
  });

  it("workouts: keeps the newest sessions and the whole-window rollup", () => {
    const block = {
      recent: Array.from({ length: 15 }, (_, i) => ({
        date: `2026-09-${String(30 - i).padStart(2, "0")}`,
        sport: "RUNNING",
        durationMin: 30 + i,
      })),
      perSport: [{ sport: "RUNNING", count: 40, totalDurationMin: 1500 }],
      totalInWindow: 40,
    };
    expect(condenseSeriesBlock(block, 1, "workouts")).toBe(true);
    expect(block.recent).toHaveLength(KEEP_SESSIONS);
    expect(block.recent[0].date).toBe("2026-09-30");
    expect(block.perSport[0].count).toBe(40);
    expect(condenseSeriesBlock(block, 2, "workouts")).toBe(false);
  });
});

describe("the prompt-budget pass on a single-source read", () => {
  it("condenses the requested block last and never swaps it for a marker", async () => {
    const { degradeToBudget } = await vi.importActual<
      typeof import("@/lib/ai/coach/snapshot")
    >("@/lib/ai/coach/snapshot");
    const big = () => ({
      unit: "kg",
      timeline: { recent: recent(14), weekly: weeks(520, 2016) },
    });
    const snap: Record<string, unknown> = {
      fatMass: big(),
      steps: big(),
      walkingSpeed: big(),
    };
    const clusters = new Map([
      ["fatMass", "body"],
      ["steps", "activity"],
      ["walkingSpeed", "mobility"],
    ] as const);
    const degraded = degradeToBudget(
      snap,
      new Map(clusters),
      new Set(["fatMass"]),
      (key) =>
        key === "fatMass"
          ? { value: days(534, "2025-03-01", (i) => 20 + i / 100) }
          : undefined,
    );
    expect(snap.steps).toEqual({ omitted: "trimmed for prompt budget" });
    expect(snap.walkingSpeed).toEqual({ omitted: "trimmed for prompt budget" });
    const fat = snap.fatMass as Record<string, unknown>;
    expect(fat).not.toHaveProperty("omitted");
    expect(fat.summary).toMatchObject({ days: 534, last: 25.33 });
    expect(degraded.map((d) => d.key).at(-1)).toBe("fatMass");
  });
});

describe("the MCP read stays as it was", () => {
  beforeEach(() => {
    buildCoachSnapshot.mockReset();
    buildCoachSourceSnapshot.mockReset();
  });

  it("hands on the section as built, without the Coach's figure check", async () => {
    buildCoachSourceSnapshot.mockResolvedValue({
      sections: { fatMass: { unit: "kg" } },
      referenceGrounding: null,
    });
    const result = await executeCoachTool({
      userId: "u1",
      name: "get_metric_series",
      rawArguments: JSON.stringify({ metric: "fat_mass", window: "allTime" }),
      sourceSnapshot: true,
    });
    expect(JSON.stringify(result)).toBe(
      JSON.stringify({
        present: true,
        data: { metric: "fat_mass", section: { unit: "kg" } },
      }),
    );
    expect(buildCoachSnapshot).not.toHaveBeenCalled();
  });

  it("condenses only on a Coach read of one source", async () => {
    buildCoachSnapshot.mockImplementation(async (_u, scope) =>
      scope === SHARED
        ? snapshot(
            { fatMass: { omitted: "trimmed for prompt budget" } },
            { degradedBlocks: ["fatMass"] },
          )
        : snapshot({ fatMass: FAT_MASS }),
    );
    // Shared build first (plain), then the re-read of the one source.
    await series({ metric: "fat_mass", window: "allTime" });
    expect(buildCoachSnapshot.mock.calls[0][2]).toEqual({
      reach: UNBOUNDED_REACH,
    });
    expect(buildCoachSnapshot.mock.calls[1][2]).toEqual({
      reach: UNBOUNDED_REACH,
      condenseRequested: true,
    });
    // A window other than the turn's is its own single-source read.
    buildCoachSnapshot.mockClear();
    await series({ metric: "fat_mass", window: "last90days" });
    expect(buildCoachSnapshot.mock.calls[0][2]).toEqual({
      reach: UNBOUNDED_REACH,
      condenseRequested: true,
    });
  });
});

describe("dailyPoints", () => {
  it("states each local day's value in the reader's unit", async () => {
    const { dailyPoints } = await import("@/lib/ai/coach/snapshot-series");
    const { getReadingTransform } =
      await import("@/lib/measurements/display-transform");
    const rows = [
      { measuredAt: new Date("2026-09-01T06:00:00Z"), value: 80 },
      { measuredAt: new Date("2026-09-01T20:00:00Z"), value: 82 },
      { measuredAt: new Date("2026-09-02T06:00:00Z"), value: 81 },
    ];
    expect(dailyPoints(rows, "UTC")).toEqual([
      { date: "2026-09-01", value: 81 },
      { date: "2026-09-02", value: 81 },
    ]);
    const lb = dailyPoints(
      rows,
      "UTC",
      undefined,
      getReadingTransform("WEIGHT", {
        ...DEFAULT_UNIT_PREFERENCES,
        system: "imperial",
      }),
    );
    expect(lb[0].value).toBeCloseTo(178.6, 0);
  });
});
