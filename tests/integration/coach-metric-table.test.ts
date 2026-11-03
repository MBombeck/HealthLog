/**
 * v1.39.4 — a Coach result table holds the chart's numbers.
 *
 * Seeds real rows for a user east of UTC — readings either side of local
 * midnight and a day two sources both measured — and pins that the table
 * `get_metric_table` builds equals `readDailySeries` for the same window, day
 * by day, and that its weeks are the chart's own weekly fold of those days.
 * Then pins that `show_result` reaches a stored table only inside the
 * conversation it was written to.
 */
import { DEFAULT_UNIT_PREFERENCES } from "@/lib/measurements/display-transform";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import { readDailySeries } from "@/lib/measurements/daily-series-read";
import { loadUserSourcePriority } from "@/lib/rollups/measurement-read";
import { recomputeUserRollups } from "@/lib/rollups/measurement-rollups";
import { bucketTimeSeries } from "@/lib/charts/bucket-time-series";
import { userDayKey } from "@/lib/tz/format";
import {
  readMetricTable,
  resolveTableRange,
} from "@/lib/ai/coach/results/metric-table-tool";
import { createResultRefAllocator } from "@/lib/ai/coach/results/refs";
import { executeCoachTool } from "@/lib/ai/coach/tools/executor";
import { appendMessage, createConversation } from "@/lib/ai/coach/persistence";
import type { CoachResultTable } from "@/lib/ai/coach/types";

vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: vi.fn(() => null),
}));
// The snapshot the tool asks for its gate needs no feature extraction.
vi.mock("@/lib/insights/features", () => ({
  extractFeatures: vi.fn(async () => ({})),
}));

const TZ = "Pacific/Auckland";
// 13:00 on 15 March in Auckland (NZDT, UTC+13).
const NOW = new Date("2026-03-15T00:00:00.000Z");

let seq = 0;
async function seedUser() {
  seq += 1;
  return getPrismaClient().user.create({
    data: {
      username: `metric-table-${seq}`,
      email: `metric-table-${seq}@example.test`,
      role: "USER",
      timezone: TZ,
    },
  });
}

async function seedPulse(
  userId: string,
  rows: Array<{
    at: string;
    value: number;
    source?: "MANUAL" | "WITHINGS" | "APPLE_HEALTH";
  }>,
) {
  await getPrismaClient().measurement.createMany({
    data: rows.map((r) => ({
      userId,
      type: "PULSE" as const,
      value: r.value,
      unit: "bpm",
      source: r.source ?? "MANUAL",
      measuredAt: new Date(r.at),
    })),
  });
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("get_metric_table — the chart's numbers", () => {
  it("equals readDailySeries day by day, across local midnight and duplicate sources", async () => {
    const user = await seedUser();
    await seedPulse(user.id, [
      // 23:30 on 10 March in Auckland — still the 10th there.
      { at: "2026-03-10T10:30:00.000Z", value: 70 },
      // 00:30 on 11 March in Auckland — the 10th in UTC, the 11th locally.
      { at: "2026-03-10T11:30:00.000Z", value: 90 },
      // Two sources measured the 12th: the table keeps one, not their mean.
      { at: "2026-03-11T19:00:00.000Z", value: 60, source: "MANUAL" },
      { at: "2026-03-11T19:05:00.000Z", value: 80, source: "WITHINGS" },
      // Early in the window, and outside it.
      { at: "2026-02-15T20:00:00.000Z", value: 66 },
      { at: "2026-02-01T20:00:00.000Z", value: 99 },
    ]);

    const table = await readMetricTable({
      userId: user.id,
      metric: "pulse",
      window: "last30days",
      period: "current",
      granularity: "day",
      timeZone: TZ,
      locale: "en",
      ref: "r1",
      units: DEFAULT_UNIT_PREFERENCES,
      now: NOW,
    });
    expect(table).not.toBeNull();

    const range = resolveTableRange({
      window: "last30days",
      period: "current",
      timeZone: TZ,
      now: NOW,
    });
    const chart = await readDailySeries({
      userId: user.id,
      type: "PULSE",
      from: range.from,
      to: range.to,
      priorityJson: await loadUserSourcePriority(user.id),
      timeZone: TZ,
    });
    const chartByDay = new Map(
      chart.map((row) => [userDayKey(new Date(row.measuredAt), TZ), row.value]),
    );

    expect(table!.rows).toHaveLength(30);
    for (const row of table!.rows) {
      expect(row[1], String(row[0])).toBe(
        chartByDay.get(row[0] as string) ?? null,
      );
    }
    const byDay = new Map(table!.rows.map((row) => [row[0], row]));
    expect(byDay.get("2026-03-10")?.[1]).toBe(70);
    expect(byDay.get("2026-03-11")?.[1]).toBe(90);
    expect([60, 80]).toContain(byDay.get("2026-03-12")?.[1]);
    expect(byDay.get("2026-03-12")?.[2]).toBe(1);
    expect(byDay.get("2026-03-13")?.[1]).toBeNull();
    expect(byDay.has("2026-02-02")).toBe(false);
  });

  it("folds weeks exactly as the chart folds the same days", async () => {
    const user = await seedUser();
    const rows = Array.from({ length: 80 }, (_, i) => ({
      at: new Date(
        NOW.getTime() - i * 86_400_000 - 3 * 3_600_000,
      ).toISOString(),
      value: 55 + (i % 11),
    }));
    await seedPulse(user.id, rows);

    const table = await readMetricTable({
      userId: user.id,
      metric: "pulse",
      window: "last90days",
      period: "current",
      granularity: "week",
      timeZone: TZ,
      locale: "en",
      ref: "r1",
      units: DEFAULT_UNIT_PREFERENCES,
      now: NOW,
    });
    const range = resolveTableRange({
      window: "last90days",
      period: "current",
      timeZone: TZ,
      now: NOW,
    });
    const days = await readDailySeries({
      userId: user.id,
      type: "PULSE",
      from: range.from,
      to: range.to,
      priorityJson: null,
      timeZone: TZ,
    });
    const weeks = bucketTimeSeries(
      days.map((row) => ({
        timestamp: new Date(row.measuredAt),
        values: { PULSE: row.value },
      })),
      { bucket: "week", timeZone: TZ },
    );
    const byWeek = new Map(table!.rows.map((row) => [row[0], row[1]]));
    expect(weeks.points.length).toBeGreaterThan(10);
    for (const point of weeks.points) {
      const monday = new Date(point.timestamp).toISOString().slice(0, 10);
      expect(byWeek.get(monday), monday).toBe(point.values.PULSE);
    }
  });

  it("serves the same table through the tool, named for the turn", async () => {
    const user = await seedUser();
    await seedPulse(user.id, [{ at: "2026-03-14T20:00:00.000Z", value: 64 }]);
    const conversation = await createConversation({
      userId: user.id,
      title: "pulse",
    });
    const result = await executeCoachTool({
      userId: user.id,
      name: "get_metric_table",
      rawArguments: JSON.stringify({ metric: "pulse", window: "last7days" }),
      turn: {
        conversationId: conversation.id,
        locale: "en",
        priorResults: [],
        refs: createResultRefAllocator(),
        now: NOW,
      },
    });
    expect(result.present).toBe(true);
    expect(result.resultRef).toBe("r1");
    expect(result.table?.rows.at(-1)).toEqual(["2026-03-15", 64, 1]);
    expect(JSON.stringify(result.data)).not.toContain("rowsNote");
  });
});

describe("get_metric_table — all time", () => {
  const WEST = "America/Los_Angeles";
  // 10:00 on 20 September in Los Angeles.
  const WEST_NOW = new Date("2026-09-20T17:00:00.000Z");

  async function seedStepsUser() {
    seq += 1;
    return getPrismaClient().user.create({
      data: {
        username: `metric-table-steps-${seq}`,
        email: `metric-table-steps-${seq}@example.test`,
        role: "USER",
        timezone: WEST,
      },
    });
  }

  /** One step row a day at 18:00 UTC from `from` for `days` days. */
  function stepDays(from: string, days: number, value = 8_000) {
    const start = Date.parse(`${from}T18:00:00.000Z`);
    return Array.from({ length: days }, (_, i) => ({
      at: new Date(start + i * 86_400_000),
      value: value + (i % 5) * 100,
    }));
  }

  async function seedSteps(
    userId: string,
    rows: Array<{ at: Date; value: number }>,
  ) {
    await getPrismaClient().measurement.createMany({
      data: rows.map((r) => ({
        userId,
        type: "ACTIVITY_STEPS" as const,
        value: r.value,
        unit: "count",
        source: "APPLE_HEALTH" as const,
        measuredAt: r.at,
      })),
    });
  }

  function utcMonthTotals(rows: Array<{ at: Date; value: number }>) {
    const totals = new Map<string, number>();
    for (const r of rows) {
      const month = r.at.toISOString().slice(0, 7);
      totals.set(month, (totals.get(month) ?? 0) + r.value);
    }
    return totals;
  }

  const read = (userId: string) =>
    readMetricTable({
      userId,
      metric: "steps",
      window: "allTime",
      period: "current",
      granularity: undefined,
      timeZone: WEST,
      locale: "en",
      ref: "r1",
      units: DEFAULT_UNIT_PREFERENCES,
      now: WEST_NOW,
    });

  it("gives each month its step total, the same for a short and a long history, from the tier or the live table", async () => {
    const recent = stepDays("2026-05-01", 120);
    const old = stepDays("2023-01-10", 60, 5_000);

    const short = await seedStepsUser();
    await seedSteps(short.id, recent);
    const long = await seedStepsUser();
    await seedSteps(long.id, [...old, ...recent]);
    for (const user of [short, long]) {
      await recomputeUserRollups(user.id, {
        from: new Date("2022-12-01T00:00:00.000Z"),
        to: WEST_NOW,
      });
    }

    const expected = utcMonthTotals(recent);
    const shortTable = (await read(short.id))!;
    const longTable = (await read(long.id))!;
    expect(shortTable.columns[1].labelKey).toBe("coach.result.column.total");
    for (const table of [shortTable, longTable]) {
      const byMonth = new Map(table.rows.map((row) => [row[0], row[1]]));
      for (const [month, total] of expected) {
        expect(byMonth.get(month), month).toBe(total);
      }
      // 1 May 18:00 UTC is still 1 May in Los Angeles; nothing lands in April.
      expect(byMonth.get("2026-04") ?? null).toBeNull();
    }
    const longByMonth = new Map(longTable.rows.map((row) => [row[0], row[1]]));
    for (const [month, total] of utcMonthTotals(old)) {
      expect(longByMonth.get(month), month).toBe(total);
    }

    // Without the tier the live table serves the same months.
    await getPrismaClient().measurementRollup.deleteMany({
      where: { userId: long.id },
    });
    const liveTable = (await read(long.id))!;
    expect(liveTable.rows).toEqual(longTable.rows);
  });
});

describe("show_result — only within the conversation", () => {
  it("resolves a stored table of this conversation and nothing of another", async () => {
    const user = await seedUser();
    const other = await seedUser();
    await seedPulse(user.id, [{ at: "2026-03-14T20:00:00.000Z", value: 64 }]);
    const table = (await readMetricTable({
      userId: user.id,
      metric: "pulse",
      window: "last7days",
      period: "current",
      granularity: "day",
      timeZone: TZ,
      locale: "en",
      ref: "r1",
      units: DEFAULT_UNIT_PREFERENCES,
      now: NOW,
    })) as CoachResultTable;
    const {
      chart: _chart,
      columns: _c,
      rows: _r,
      truncated: _t,
      ...meta
    } = table;

    const home = await createConversation({ userId: user.id, title: "a" });
    const elsewhere = await createConversation({ userId: user.id, title: "b" });
    const foreign = await createConversation({ userId: other.id, title: "c" });
    const stored = await appendMessage({
      conversationId: home.id,
      role: "assistant",
      content: "Here is your pulse.",
      metricSource: { windows: [], metrics: [], results: [meta] },
      results: [table],
    });

    const prior = [{ messageId: stored.id, turnIndex: 1, results: [meta] }];
    const run = (conversationId: string, userId = user.id) =>
      executeCoachTool({
        userId,
        name: "show_result",
        rawArguments: JSON.stringify({ ref: "m1.r1" }),
        turn: {
          conversationId,
          locale: "en",
          priorResults: prior,
          refs: createResultRefAllocator(),
          now: NOW,
        },
      });

    const shown = await run(home.id);
    expect(shown.present).toBe(true);
    expect(shown.table?.rows).toEqual(table.rows);
    expect(shown.table?.reusedFrom).toEqual({
      messageId: stored.id,
      ref: "r1",
    });

    // The same name, handed to a turn of another conversation of the same
    // account, or of another account, reaches nothing.
    expect(await run(elsewhere.id)).toEqual({
      present: false,
      reason: "unknown_result",
    });
    expect(await run(foreign.id, other.id)).toEqual({
      present: false,
      reason: "unknown_result",
    });
  });
});
