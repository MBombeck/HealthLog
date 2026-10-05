/**
 * v1.39.4 — the executor's result tables: `get_metric_table` behind the
 * same gate as every read, `show_result` bounded to the conversation the
 * turn belongs to, the older tools' projections, and the table never in
 * what the model reads.
 */
import { DEFAULT_UNIT_PREFERENCES } from "@/lib/measurements/display-transform";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CoachSnapshotResult } from "@/lib/ai/coach/snapshot";
import type { CoachResultTable } from "@/lib/ai/coach/types";

const buildCoachSnapshot =
  vi.fn<(userId: string, scope?: unknown) => Promise<CoachSnapshotResult>>();
vi.mock("@/lib/ai/coach/snapshot", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  buildCoachSnapshot: (userId: string, scope?: unknown) =>
    buildCoachSnapshot(userId, scope),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: {
      groupBy: () => Promise.resolve([]),
      findMany: () => Promise.resolve([]),
    },
  },
}));
vi.mock("@/lib/tz/resolver", () => ({
  resolveUserTimezone: () => Promise.resolve("UTC"),
}));
const readDailySeries = vi.fn();
vi.mock("@/lib/measurements/daily-series-read", () => ({
  readDailySeries: (...a: unknown[]) => readDailySeries(...a),
}));
vi.mock("@/lib/rollups/measurement-read", () => ({
  loadUserSourcePriority: vi.fn(async () => null),
}));
const readMessageResults = vi.fn();
vi.mock("@/lib/ai/coach/persistence", () => ({
  readMessageResults: (...a: unknown[]) => readMessageResults(...a),
}));
const resolveModuleMap = vi.fn();
vi.mock("@/lib/modules/gate", () => ({
  resolveModuleMap: (...a: unknown[]) => resolveModuleMap(...a),
}));

import {
  admittedPriorResults,
  executeCoachTool,
  type CoachToolTurnContext,
} from "@/lib/ai/coach/tools/executor";
import { createResultRefAllocator } from "../refs";
import { UNBOUNDED_REACH } from "@/lib/ai/coach/history-reach";
import { findUnverifiedCoachNumbers } from "@/lib/ai/coach/coach-prose-grounding";

const NOW = new Date("2026-09-27T10:00:00Z");

function snapshot(sections: Record<string, unknown>): CoachSnapshotResult {
  return {
    snapshotJson: JSON.stringify(sections),
    sections,
    provenance: { windows: [], metrics: [] },
    referenceGrounding: null,
    units: DEFAULT_UNIT_PREFERENCES,
  };
}

const STORED: CoachResultTable = {
  ref: "r1",
  source: {
    tool: "get_metric_table",
    domain: "pulse",
    window: "last7days",
    period: "current",
    granularity: "day",
  },
  shape: "timeSeries",
  titleKey: "coach.result.title.byDay",
  title: "Pulse by day",
  rowCount: 2,
  chartKind: null,
  displayed: true,
  columns: [
    {
      key: "day",
      kind: "period",
      labelKey: "coach.result.column.day",
      label: "Day",
    },
    {
      key: "value",
      kind: "number",
      labelKey: "coach.result.column.value",
      label: "Value",
      unit: "bpm",
      decimals: 0,
    },
  ],
  rows: [
    ["2026-09-26", 61],
    ["2026-09-27", 63],
  ],
  truncated: false,
  chart: null,
};

function turn(
  overrides: Partial<CoachToolTurnContext> = {},
): CoachToolTurnContext {
  return {
    conversationId: "c1",
    locale: "en",
    priorResults: [
      {
        messageId: "m-a2",
        turnIndex: 2,
        results: [
          {
            ref: STORED.ref,
            source: STORED.source,
            shape: STORED.shape,
            titleKey: STORED.titleKey,
            title: STORED.title,
            rowCount: STORED.rowCount,
            chartKind: null,
            displayed: true,
          },
        ],
      },
    ],
    refs: createResultRefAllocator(),
    now: NOW,
    ...overrides,
  };
}

beforeEach(() => {
  buildCoachSnapshot.mockReset();
  readDailySeries.mockReset();
  readMessageResults.mockReset();
  resolveModuleMap.mockReset();
  resolveModuleMap.mockResolvedValue({});
  buildCoachSnapshot.mockResolvedValue(
    snapshot({ scope: { sources: ["pulse", "bp", "weight", "workouts"] } }),
  );
  readDailySeries.mockResolvedValue([
    {
      type: "PULSE",
      value: 62.4,
      measuredAt: "2026-09-26T00:00:00.000Z",
      count: 3,
    },
  ]);
});

describe("get_metric_table", () => {
  it("names the table and keeps the rows out of what the model reads", async () => {
    const result = await executeCoachTool({
      userId: "u1",
      name: "get_metric_table",
      rawArguments: JSON.stringify({ metric: "pulse", window: "last7days" }),
      turn: turn(),
    });
    expect(result.present).toBe(true);
    expect(result.resultRef).toBe("r1");
    expect(result.table?.ref).toBe("r1");
    expect(result.table?.rows).toHaveLength(7);
    const data = result.data as Record<string, unknown>;
    expect(data).not.toHaveProperty("table");
    expect(data.periods).toBe(7);
    expect(data.periodsWithReadings).toBe(1);
    expect(data.rows).toEqual([["2026-09-26", 62, 3]]);
  });

  it("outside a chat turn answers the summary alone", async () => {
    const result = await executeCoachTool({
      userId: "u1",
      name: "get_metric_table",
      rawArguments: JSON.stringify({ metric: "pulse" }),
    });
    expect(result.present).toBe(true);
    expect(result.table).toBeUndefined();
    expect(result.resultRef).toBeUndefined();
  });

  it("points glucose, adherence and workouts at their own tools", async () => {
    for (const [metric, reason] of [
      ["glucose", "use_get_glucose_panel"],
      ["compliance", "use_get_medication_compliance"],
      ["workouts", "use_get_workouts"],
    ]) {
      const result = await executeCoachTool({
        userId: "u1",
        name: "get_metric_table",
        rawArguments: JSON.stringify({ metric }),
        turn: turn(),
      });
      expect(result).toEqual({ present: false, reason });
    }
    expect(readDailySeries).not.toHaveBeenCalled();
  });

  it("reads nothing for a metric the snapshot gate leaves out", async () => {
    buildCoachSnapshot.mockResolvedValue(
      snapshot({ scope: { sources: ["bp"] } }),
    );
    const result = await executeCoachTool({
      userId: "u1",
      name: "get_metric_table",
      rawArguments: JSON.stringify({ metric: "pulse", window: "last30days" }),
      turn: turn(),
    });
    expect(result).toMatchObject({
      present: false,
      reason: "unavailable_in_scope",
    });
    expect(readDailySeries).not.toHaveBeenCalled();
  });

  it("reports an empty range as absence, never as an empty table", async () => {
    readDailySeries.mockResolvedValue([]);
    const result = await executeCoachTool({
      userId: "u1",
      name: "get_metric_table",
      rawArguments: JSON.stringify({ metric: "weight", period: "yearAgo" }),
      turn: turn(),
    });
    expect(result.present).toBe(false);
    expect(result.reason).toBe("no_data");
    expect(result.table).toBeUndefined();
  });

  it("hands an earlier period the current one and the change, so a correct delta grounds and a wrong one does not", async () => {
    // BP: 20–26 September average 128/82 (the week before), 27 September
    // onwards 132/80 — the current week reads higher systolic.
    readDailySeries.mockImplementation(
      async ({ type, from }: { type: string; from: Date }) => {
        const earlier = from.getTime() < Date.parse("2026-09-21T00:00:00Z");
        const [sys, dia] = earlier ? [128, 82] : [132, 80];
        const day = earlier ? "2026-09-18" : "2026-09-25";
        return [
          {
            type,
            value: type === "BLOOD_PRESSURE_SYS" ? sys : dia,
            measuredAt: `${day}T00:00:00.000Z`,
            count: 1,
          },
        ];
      },
    );
    const result = await executeCoachTool({
      userId: "u1",
      name: "get_metric_table",
      rawArguments: JSON.stringify({
        metric: "bp",
        window: "last7days",
        period: "previous",
      }),
      turn: turn(),
    });
    const data = result.data as Record<string, unknown>;
    expect(data.comparison).toMatchObject({
      with: { window: "last7days", period: "current" },
      current: { stats: { systolic: { mean: 132 }, diastolic: { mean: 80 } } },
      change: {
        systolic: { mean: { delta: 4, pctChange: 3.1 } },
        diastolic: { mean: { delta: -2, pctChange: -2.4 } },
      },
    });
    expect(
      findUnverifiedCoachNumbers(
        "Your systolic is up 4 mmHg on the week before, about 3.1%.",
        [data],
      ),
    ).toEqual([]);
    const wrong = findUnverifiedCoachNumbers(
      "Your systolic is up 9 mmHg on the week before.",
      [data],
    );
    expect(wrong.map((f) => f.value)).toContain(9);
  });

  it("adds no comparison to a current read", async () => {
    const result = await executeCoachTool({
      userId: "u1",
      name: "get_metric_table",
      rawArguments: JSON.stringify({ metric: "pulse", window: "last7days" }),
      turn: turn(),
    });
    expect(result.data).not.toHaveProperty("comparison");
    expect(readDailySeries).toHaveBeenCalledTimes(1);
  });

  it("refuses arguments outside the schema", async () => {
    const result = await executeCoachTool({
      userId: "u1",
      name: "get_metric_table",
      rawArguments: JSON.stringify({ metric: "pulse", userId: "u2" }),
      turn: turn(),
    });
    expect(result).toEqual({ present: false, reason: "invalid_arguments" });
  });

  it("stops naming tables after the sixth", async () => {
    const refs = createResultRefAllocator();
    for (let i = 0; i < 6; i += 1) refs.next();
    const result = await executeCoachTool({
      userId: "u1",
      name: "get_metric_table",
      rawArguments: JSON.stringify({ metric: "pulse" }),
      turn: turn({ refs }),
    });
    expect(result.present).toBe(true);
    expect(result.table).toBeUndefined();
  });
});

describe("show_result", () => {
  it("sends nothing of a metric the person has since excluded", async () => {
    // The snapshot gate no longer admits pulse: the stored table is not
    // even decrypted.
    buildCoachSnapshot.mockResolvedValue(snapshot({ scope: { sources: [] } }));
    readMessageResults.mockResolvedValue([STORED]);
    const result = await executeCoachTool({
      userId: "u1",
      name: "show_result",
      rawArguments: JSON.stringify({ ref: "m2.r1" }),
      turn: turn(),
    });
    expect(result).toEqual({
      present: false,
      reason: "unavailable_in_scope",
    });
    expect(buildCoachSnapshot).toHaveBeenCalledWith("u1", {
      sources: ["pulse"],
      window: "last7days",
    });
    expect(readMessageResults).not.toHaveBeenCalled();
  });

  it("copies a stored table of this conversation under a new name", async () => {
    readMessageResults.mockResolvedValue([STORED]);
    const result = await executeCoachTool({
      userId: "u1",
      name: "show_result",
      rawArguments: JSON.stringify({ ref: "m2.r1", view: "chart" }),
      turn: turn(),
    });
    expect(readMessageResults).toHaveBeenCalledWith(
      "u1",
      "c1",
      "m-a2",
      expect.any(Function),
    );
    expect(result.present).toBe(true);
    expect(result.resultRef).toBe("r1");
    expect(result.table).toMatchObject({
      ref: "r1",
      rows: STORED.rows,
      displayed: false,
      reusedFrom: { messageId: "m-a2", ref: "r1" },
    });
    expect(result.data).toMatchObject({ shownAgain: "m2.r1", periods: 2 });
    expect(readDailySeries).not.toHaveBeenCalled();
  });

  it("keeps the server's chart when no view is asked for", async () => {
    readMessageResults.mockResolvedValue([STORED]);
    const result = await executeCoachTool({
      userId: "u1",
      name: "show_result",
      rawArguments: JSON.stringify({ ref: "m2.r1" }),
      turn: turn(),
    });
    expect(result.table).toMatchObject({
      shape: "timeSeries",
      chart: { kind: "line", x: "day", series: ["value"] },
      chartKind: "line",
    });
  });

  it("shows the table first for view table, the chart kept beside it", async () => {
    readMessageResults.mockResolvedValue([STORED]);
    const result = await executeCoachTool({
      userId: "u1",
      name: "show_result",
      rawArguments: JSON.stringify({ ref: "m2.r1", view: "table" }),
      turn: turn(),
    });
    // The table shows first; the chart the server picks stays beside it.
    expect(result.table).toMatchObject({
      rows: STORED.rows,
      view: "table",
      chart: { kind: "line", x: "day", series: ["value"] },
      chartKind: "line",
    });
  });

  it("shows a day table as counts per range for view chart", async () => {
    const days = [58, 61, 62, 64, 66, 66, 67, 70, 71, 74, 63, 65];
    readMessageResults.mockResolvedValue([
      {
        ...STORED,
        rowCount: days.length,
        rows: days.map((value, index) => [
          `2026-09-${String(10 + index).padStart(2, "0")}`,
          value,
        ]),
      },
    ]);
    const result = await executeCoachTool({
      userId: "u1",
      name: "show_result",
      rawArguments: JSON.stringify({ ref: "m2.r1", view: "chart" }),
      turn: turn(),
    });
    expect(result.table).toMatchObject({
      ref: "r1",
      shape: "distribution",
      titleKey: "coach.result.title.distribution",
      chartKind: "histogram",
      chart: { kind: "histogram", column: "value", unit: "bpm" },
      reusedFrom: { messageId: "m-a2", ref: "r1" },
    });
    expect(result.table?.rows[0]).toEqual(["55–60 bpm", 1]);
    // The model reads the counts it can talk about, not the days.
    expect(result.data).toMatchObject({
      shape: "distribution",
      stats: { count: { total: days.length } },
    });
  });

  it("answers unknown_result for a name this conversation does not hold", async () => {
    // A name that another conversation of the same account might hold.
    const result = await executeCoachTool({
      userId: "u1",
      name: "show_result",
      rawArguments: JSON.stringify({ ref: "m5.r1" }),
      turn: turn(),
    });
    expect(result).toEqual({ present: false, reason: "unknown_result" });
    expect(readMessageResults).not.toHaveBeenCalled();
  });

  it("answers unknown_result when the owner-narrowed read finds nothing", async () => {
    readMessageResults.mockResolvedValue(null);
    const result = await executeCoachTool({
      userId: "u1",
      name: "show_result",
      rawArguments: JSON.stringify({ ref: "m2.r1" }),
      turn: turn(),
    });
    expect(result).toEqual({ present: false, reason: "unknown_result" });
  });

  it("answers unknown_result outside a chat turn", async () => {
    const result = await executeCoachTool({
      userId: "u1",
      name: "show_result",
      rawArguments: JSON.stringify({ ref: "m2.r1" }),
    });
    expect(result).toEqual({ present: false, reason: "unknown_result" });
  });

  it("passes a withheld table on as withheld", async () => {
    resolveModuleMap.mockResolvedValue({ recovery: false });
    readMessageResults.mockImplementation(
      async (
        _u: string,
        _c: string,
        _m: string,
        withhold: (domain: string) => boolean,
      ) =>
        withhold("hrv")
          ? [{ ref: "r1", withheld: "module_disabled" }]
          : [STORED],
    );
    const result = await executeCoachTool({
      userId: "u1",
      name: "show_result",
      rawArguments: JSON.stringify({ ref: "m2.r1" }),
      turn: turn(),
    });
    expect(result).toEqual({ present: false, reason: "module_disabled" });
  });
});

describe("projections of the older tools", () => {
  it("gives a present get_workouts result a sport table and a name", async () => {
    buildCoachSnapshot.mockResolvedValue(
      snapshot({
        scope: { sources: ["workouts"] },
        workouts: {
          recent: [],
          perSport: [
            {
              sport: "RUNNING",
              count: 4,
              totalDurationMin: 180,
              totalEnergyKcal: 900,
            },
            {
              sport: "YOGA",
              count: 2,
              totalDurationMin: 90,
              totalEnergyKcal: 200,
            },
          ],
          totalInWindow: 6,
        },
      }),
    );
    const result = await executeCoachTool({
      userId: "u1",
      name: "get_workouts",
      rawArguments: "{}",
      turn: turn(),
    });
    expect(result.resultRef).toBe("r1");
    expect(result.table?.shape).toBe("categoryCounts");
    expect(result.table?.rows).toEqual([
      [expect.any(String), 4, 180],
      [expect.any(String), 2, 90],
    ]);
    // What the model reads is the tool's own payload, unchanged.
    expect((result.data as { totalInWindow: number }).totalInWindow).toBe(6);
  });
});

describe("admittedPriorResults", () => {
  const meta = (ref: string, domain: string) => ({
    ...turn().priorResults[0].results[0],
    ref,
    source: { ...STORED.source, domain } as CoachResultTable["source"],
  });
  const prior = [
    {
      messageId: "m-a2",
      turnIndex: 2,
      results: [meta("r1", "pulse"), meta("r2", "steps"), meta("r3", "labs")],
    },
    { messageId: "m-a4", turnIndex: 4, results: [meta("r1", "steps")] },
  ];

  it("drops a metric the person excluded and keeps what no exclusion names", async () => {
    const out = await admittedPriorResults({
      userId: "u1",
      reach: UNBOUNDED_REACH,
      prefs: { excludeMetrics: ["steps"] },
      scope: undefined,
      prior,
    });
    expect(
      out.map((t) => [t.turnIndex, t.results.map((r) => r.source.domain)]),
    ).toEqual([[2, ["pulse", "labs"]]]);
  });

  it("keeps to the conversation's scope", async () => {
    const out = await admittedPriorResults({
      userId: "u1",
      reach: UNBOUNDED_REACH,
      prefs: { excludeMetrics: [] },
      scope: { sources: ["steps"] },
      prior,
    });
    expect(
      out.map((t) => [t.turnIndex, t.results.map((r) => r.source.domain)]),
    ).toEqual([
      [2, ["steps", "labs"]],
      [4, ["steps"]],
    ]);
  });

  it("drops a metric whose module is switched off", async () => {
    resolveModuleMap.mockResolvedValue({ mood: false });
    const out = await admittedPriorResults({
      userId: "u1",
      reach: UNBOUNDED_REACH,
      prefs: { excludeMetrics: [] },
      scope: undefined,
      prior: [
        {
          messageId: "m-a2",
          turnIndex: 2,
          results: [meta("r1", "mood"), meta("r2", "pulse")],
        },
      ],
    });
    expect(out.flatMap((t) => t.results.map((r) => r.source.domain))).toEqual([
      "pulse",
    ]);
  });
});
