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
  condenseSeriesBlock,
  isoWeekMonth,
  summarisePoints,
  weeklyToMonthly,
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

  it("summarises points in time order", () => {
    expect(
      summarisePoints([
        { at: "2026-09-02", value: 18 },
        { at: "2025-W10", value: 21 },
        { at: "2026-09-01", value: 17 },
      ]),
    ).toEqual({
      from: "2025-W10",
      to: "2026-09-02",
      first: 21,
      last: 18,
      min: 17,
      max: 21,
      mean: 18.67,
      change: -3,
      points: 3,
    });
    expect(summarisePoints([])).toBeNull();
  });

  it("keeps numbers through every step and names what it cut", () => {
    const block = {
      unit: "kg",
      timeline: { recent: recent(14), weekly: weeks(150) },
    };
    expect(condenseSeriesBlock(block, 1)).toBe(true);
    expect(block.timeline.recent).toHaveLength(KEEP_DAILY_ROWS);
    expect(block.timeline.recent.at(-1)?.value).toBe(43);
    expect(condenseSeriesBlock(block, 2)).toBe(true);
    expect(block.timeline).not.toHaveProperty("weekly");
    const monthly = (block.timeline as { monthly?: unknown[] }).monthly;
    expect(monthly!.length).toBeGreaterThan(30);
    expect(condenseSeriesBlock(block, 3)).toBe(true);
    expect((block.timeline as { monthly?: unknown[] }).monthly).toHaveLength(
      KEEP_MONTHLY_ROWS,
    );
    // The summary was taken before anything was cut: every week and day.
    const summary = (block as { summary?: Record<string, unknown> }).summary;
    expect(summary).toMatchObject({
      from: "2023-W01",
      to: "2026-09-14",
      first: 20,
      last: 43,
      points: 164,
    });
    expect((block as { condensed?: string[] }).condensed).toEqual([
      `daily values: newest ${KEEP_DAILY_ROWS} days kept`,
      "weekly means folded into monthly means",
      `monthly means: newest ${KEEP_MONTHLY_ROWS} months kept`,
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
    condenseSeriesBlock(block, 2);
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
    expect(condenseSeriesBlock(block, 1)).toBe(false);
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
    );
    expect(snap.steps).toEqual({ omitted: "trimmed for prompt budget" });
    expect(snap.walkingSpeed).toEqual({ omitted: "trimmed for prompt budget" });
    const fat = snap.fatMass as Record<string, unknown>;
    expect(fat).not.toHaveProperty("omitted");
    expect(fat.summary).toMatchObject({ points: 534, last: 43 });
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
