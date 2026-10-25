/**
 * The provenance explanation says what the canonical readers do.
 *
 *  1. The ladder the explanation reads (`ladderFor` + `ladderRank`) gives
 *     every (type, source) the rank the SQL CASE from `buildSourceRankCase`
 *     gives it, for the default ladders and for a reordered one. The CASE is
 *     evaluated from its own text here, so a change to either side fails.
 *  2. The provenance query orders a day's sources by exactly the expression
 *     `canonicalMeasurementsCte` picks with: the same rank CASE, then the
 *     source name.
 *  3. The pick explanation and the comparison are right on hand-made rows.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queryRawUnsafe: vi.fn(),
  priority: null as unknown,
}));
vi.mock("@/lib/db", () => ({
  prisma: { $queryRawUnsafe: mocks.queryRawUnsafe },
}));
vi.mock("@/lib/rollups/measurement-read", () => ({
  loadUserSourcePriority: vi.fn(async () => mocks.priority),
}));

import {
  RANKED_TYPES,
  buildSourceRankCase,
  canonicalMeasurementsCte,
} from "@/lib/analytics/source-rank-sql";
import { measurementSourceEnum } from "@/lib/validations/measurement";
import type { MeasurementType } from "@/generated/prisma/client";

import {
  OFF_LADDER_RANK,
  buildComparison,
  explainPick,
  ladderFor,
  ladderRank,
  readDayProvenance,
  type SourceRow,
} from "../source-provenance";

/** Evaluate the CASE text `buildSourceRankCase` emits for one (type, source). */
function evaluateCase(sql: string, type: string, source: string): number {
  const branch = new RegExp(
    `WHEN "type" = '${type}' THEN \\(CASE "source" (.*?) ELSE 90 END\\)`,
  ).exec(sql);
  if (!branch) return 90;
  const when = new RegExp(`WHEN '${source}' THEN (\\d+)`).exec(branch[1]);
  return when ? Number(when[1]) : 90;
}

const REORDERED = {
  metricPriority: {
    steps: ["OURA", "WHOOP", "APPLE_HEALTH"],
    sleep: ["WHOOP", "OURA"],
    hrvRmssd: ["OURA"],
  },
};

describe("the explanation ranks exactly like the SQL", () => {
  it.each([
    ["default ladders", null],
    ["a reordered ladder", REORDERED],
  ])("%s", (_label, priority) => {
    const sql = buildSourceRankCase(priority, '"type"', '"source"');
    let compared = 0;
    for (const type of RANKED_TYPES) {
      const { ladder } = ladderFor(priority, type);
      for (const source of measurementSourceEnum.options) {
        expect(ladderRank(ladder, source), `${type}/${source}`).toBe(
          evaluateCase(sql, type, source),
        );
        compared += 1;
      }
    }
    // A matcher that found no branch would agree with everything.
    expect(compared).toBeGreaterThan(100);
    expect(sql).toContain(`WHEN "type" = 'ACTIVITY_STEPS'`);
  });

  it("a type without a ladder is not ranked", () => {
    expect(ladderFor(null, "BLOOD_GLUCOSE" as MeasurementType).ranked).toBe(
      false,
    );
  });

  it("a reordered ladder moves the rank", () => {
    const { ladder } = ladderFor(REORDERED, "ACTIVITY_STEPS");
    expect(ladderRank(ladder, "OURA")).toBe(0);
    expect(ladderRank(ladder, "WHOOP")).toBe(1);
    expect(ladderRank(ladder, "NOT_A_SOURCE")).toBe(OFF_LADDER_RANK);
  });
});

describe("the provenance query orders like the canonical pick", () => {
  beforeEach(() => {
    mocks.queryRawUnsafe.mockReset();
    mocks.queryRawUnsafe.mockResolvedValue([]);
  });

  it.each([null, REORDERED])("with priority %j", async (priority) => {
    mocks.priority = priority;
    await readDayProvenance({
      userId: "u1",
      type: "SLEEP_DURATION",
      date: "2026-10-01",
    });
    const [sql, userId, from, to] = mocks.queryRawUnsafe.mock.calls[0];
    const rank = buildSourceRankCase(priority, '"type"', '"source"');
    const squash = (s: string) => s.replace(/\s+/g, " ");
    expect(squash(sql)).toContain(
      squash(
        `ORDER BY date_trunc('day', "measured_at"), (${rank}), "source"::text`,
      ),
    );
    // The shared pick partitions by type and UTC day and orders each day's
    // rows by the same keys.
    expect(squash(canonicalMeasurementsCte(rank))).toContain(
      squash(
        `PARTITION BY mm."type", date_trunc('day', mm."measured_at") ORDER BY (${rank}), mm."source"::text`,
      ),
    );
    // Values are bound, never spliced.
    expect(userId).toBe("u1");
    expect((from as Date).toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect((to as Date).toISOString()).toBe("2026-10-02T00:00:00.000Z");
    expect(sql).not.toContain("u1");
  });
});

function row(source: string, rank: number, value: number): SourceRow {
  return {
    source,
    rank,
    readings: 1,
    value,
    min: value,
    max: value,
    firstAt: "2026-10-01T06:00:00.000Z",
    lastAt: "2026-10-01T06:00:00.000Z",
    unit: "min",
    devices: ["unknown"],
  };
}

describe("explainPick", () => {
  it("names the highest on the ladder and why the others lost", () => {
    const out = explainPick(true, [
      row("WHOOP", 0, 420),
      row("OURA", 2, 400),
      row("FITBIT", 90, 380),
    ]);
    expect(out.picked).toBe("WHOOP");
    expect(out.pickReason).toBe("highest_on_ladder");
    expect(out.passes).toEqual([null, "lower_on_ladder", "not_on_ladder"]);
  });

  it("calls a pick among off-ladder sources a name tiebreak", () => {
    const out = explainPick(true, [row("FITBIT", 90, 1), row("OURA", 90, 2)]);
    expect(out.pickReason).toBe("name_tiebreak");
    expect(out.passes).toEqual([null, "name_tiebreak"]);
  });

  it("one source is simply the only one; an unranked type picks nothing", () => {
    expect(explainPick(true, [row("OURA", 1, 5)]).pickReason).toBe(
      "only_source",
    );
    const unranked = explainPick(false, [row("A", 90, 1), row("B", 90, 2)]);
    expect(unranked.picked).toBeNull();
    expect(unranked.pickReason).toBe("not_ranked");
    expect(explainPick(true, []).picked).toBeNull();
  });
});

describe("buildComparison", () => {
  const rows = [
    { ...row("OURA", 1, 400), day: "2026-10-01" },
    { ...row("WHOOP", 0, 430), day: "2026-10-01" },
    { ...row("OURA", 1, 410), day: "2026-10-02" },
    { ...row("OURA", 1, 390), day: "2026-10-03" },
    { ...row("WHOOP", 0, 450), day: "2026-10-03" },
  ].sort((x, y) => x.day.localeCompare(y.day) || x.rank - y.rank);

  it("lines the two up per day and compares only days both cover", () => {
    const c = buildComparison({
      type: "SLEEP_DURATION",
      from: "2026-10-01",
      to: "2026-10-03",
      ranked: true,
      ladder: ["WHOOP", "APPLE_HEALTH", "OURA"],
      rows,
      a: "OURA",
      b: "WHOOP",
    });
    expect(c.days).toEqual([
      { date: "2026-10-01", a: 400, b: 430, picked: "WHOOP" },
      { date: "2026-10-02", a: 410, b: null, picked: "OURA" },
      { date: "2026-10-03", a: 390, b: 450, picked: "WHOOP" },
    ]);
    expect(c.summary).toMatchObject({
      daysA: 3,
      daysB: 2,
      daysBoth: 2,
      meanA: 395,
      meanB: 440,
      meanDifference: 45,
      meanAbsoluteDifference: 45,
      pickedA: 1,
      pickedB: 2,
    });
  });

  it("defaults to the two sources that cover the most days", () => {
    const c = buildComparison({
      type: "SLEEP_DURATION",
      from: "2026-10-01",
      to: "2026-10-03",
      ranked: true,
      ladder: [],
      rows,
    });
    expect([c.a, c.b]).toEqual(["OURA", "WHOOP"]);
    expect(c.sources).toEqual([
      { source: "OURA", days: 3 },
      { source: "WHOOP", days: 2 },
    ]);
  });
});
