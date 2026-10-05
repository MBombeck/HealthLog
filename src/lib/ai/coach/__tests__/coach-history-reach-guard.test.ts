/**
 * The Coach lookback limit holds for every tool.
 *
 * `coachPrefs.defaultWindow` is a limit: no Coach read may reach
 * further back than it, whatever window or period the model asks for. This
 * guard runs EVERY tool the model is offered (`COACH_TOOL_DEFS`, `show_result`
 * included) through the real executor with a 30-day limit and the widest
 * arguments the schema allows (`allTime`, `yearAgo`), once with every snapshot
 * section present and once with none (the empty-read path), and records each
 * call the executor makes into a reader. A call passes when it carries the
 * limit and asks for nothing older than 30 days. A tool passes when it made at
 * least one read and every read passed, or when it refused with
 * `outside_reach` before reading anything.
 *
 * A tool added to `COACH_TOOL_DEFS` without a case here fails the first test;
 * a case whose tool made no read and did not refuse fails too, so the guard
 * cannot go green by having nothing to check.
 *
 * The second block reads the source: every dispatch branch hands the limit
 * on, every Coach `buildCoachSnapshot(` call passes one, and the MCP call
 * sites pass none (MCP keeps its own windows). The matchers tolerate any
 * whitespace and line breaks, and each asserts a non-zero match count.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_UNIT_PREFERENCES } from "@/lib/measurements/display-transform";
import type { CoachSnapshotResult } from "@/lib/ai/coach/snapshot";
import type {
  CoachResultPeriod,
  CoachScope,
  CoachScopeWindow,
} from "@/lib/ai/coach/types";
import type { CoachHistoryReach } from "@/lib/ai/coach/history-reach";

const NOW = new Date("2026-10-04T12:00:00Z");
const LIMIT_DAYS = 30;
const FLOOR = NOW.getTime() - LIMIT_DAYS * 86_400_000;

const RANK: Record<CoachScopeWindow, number> = {
  last7days: 0,
  last30days: 1,
  last90days: 2,
  lastYear: 3,
  allTime: 4,
};

interface Read {
  reader: string;
  ok: boolean;
  detail: string;
}
const reads: Read[] = [];

function windowOk(window: CoachScopeWindow | undefined): boolean {
  return window === undefined || RANK[window] <= RANK.last30days;
}
function reachOk(reach: CoachHistoryReach | undefined): boolean {
  return reach?.days === LIMIT_DAYS;
}
function record(reader: string, ok: boolean, detail: unknown): void {
  reads.push({ reader, ok, detail: JSON.stringify(detail) });
}

let sections: Record<string, unknown> = {};

vi.mock("@/lib/ai/coach/snapshot", () => ({
  buildCoachSnapshot: async (
    _userId: string,
    scope?: CoachScope,
    options?: { reach?: CoachHistoryReach },
  ): Promise<CoachSnapshotResult> => {
    record(
      "buildCoachSnapshot",
      reachOk(options?.reach) && windowOk(scope?.window),
      { window: scope?.window, reach: options?.reach },
    );
    return {
      snapshotJson: JSON.stringify(sections),
      sections,
      provenance: { windows: [], metrics: [] },
      referenceGrounding: null,
      units: DEFAULT_UNIT_PREFERENCES,
    };
  },
}));

vi.mock("@/lib/ai/coach/results/metric-table-tool", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/ai/coach/results/metric-table-tool")
    >();
  return {
    ...actual,
    readMetricTable: async (args: {
      window: CoachScopeWindow;
      period: CoachResultPeriod;
      now?: Date;
    }) => {
      const range = actual.resolveTableRange({
        window: args.window,
        period: args.period,
        timeZone: "UTC",
        now: args.now ?? NOW,
      });
      record("readMetricTable", range.from.getTime() >= FLOOR - 86_400_000, {
        window: args.window,
        period: args.period,
        from: range.from.toISOString(),
      });
      return null;
    },
  };
});

vi.mock("@/lib/ai/coach/tools/correlations-read", () => ({
  readCoachCorrelations: async (
    _userId: string,
    _locale: string,
    options?: { reach?: CoachHistoryReach },
  ) => {
    record("readCoachCorrelations", reachOk(options?.reach), options);
    return { present: false, reason: "no_significant_pattern" };
  },
}));

vi.mock("@/lib/ai/coach/illness-snapshot", () => ({
  buildIllnessScores: async (
    _userId: string,
    _now?: Date,
    reach?: CoachHistoryReach,
  ) => {
    record("buildIllnessScores", reachOk(reach), reach);
    return null;
  },
}));

vi.mock("@/lib/ai/coach/tools/availability", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/ai/coach/tools/availability")>();
  return {
    ...actual,
    resolveEmptyRead: async (args: {
      searchedWindow?: CoachScopeWindow;
      reach?: CoachHistoryReach;
    }) => {
      record(
        "resolveEmptyRead",
        reachOk(args.reach) && windowOk(args.searchedWindow),
        { window: args.searchedWindow, reach: args.reach },
      );
      return { present: false, reason: "no_data" };
    },
    illnessBeyondReach: async (_userId: string, reach: CoachHistoryReach) => {
      record("illnessBeyondReach", reachOk(reach), reach);
      return false;
    },
    cycleRecorded: async () => true,
  };
});

vi.mock("@/lib/cycle/gate", () => ({
  isCycleAvailableForUser: async () => true,
}));
vi.mock("@/lib/i18n/user-locale", () => ({
  resolveLocaleForUser: async () => "en",
}));
vi.mock("@/lib/tz/resolver", () => ({
  resolveUserTimezone: async () => "UTC",
}));
vi.mock("@/lib/modules/gate", () => ({
  resolveModuleMap: async () => ({}),
}));
vi.mock("@/lib/ai/coach/persistence", () => ({
  readMessageResults: async () => null,
}));
vi.mock("@/lib/db", () => ({ prisma: {} }));

import { executeCoachTool } from "@/lib/ai/coach/tools/executor";
import {
  COACH_TOOL_DEFS,
  COACH_TOOL_NAMES,
  SHOW_RESULT_TOOL_NAME,
} from "@/lib/ai/coach/tools/definitions";
import { createResultRefAllocator } from "@/lib/ai/coach/results/refs";
import type { PriorResultTurn } from "@/lib/ai/coach/results/refs";

const REACH: CoachHistoryReach = { window: "last30days", days: LIMIT_DAYS };

function storedTable(ref: string, window: CoachScopeWindow) {
  return {
    ref,
    source: {
      tool: "get_metric_table" as const,
      domain: "bp" as const,
      window,
      period: "current" as const,
    },
    shape: "timeSeries" as const,
    titleKey: "coach.result.title.byDay",
    title: "Blood pressure by day",
    rowCount: 3,
    chartKind: null,
    displayed: true,
  };
}

const PRIOR: PriorResultTurn[] = [
  {
    messageId: "m-earlier",
    turnIndex: 1,
    results: [storedTable("r1", "allTime"), storedTable("r2", "last7days")],
  },
];

/**
 * One or more argument sets per tool, each the widest the schema allows.
 * Every name in `COACH_TOOL_DEFS` must have an entry.
 */
const CASES: Record<string, Array<Record<string, unknown>>> = {
  get_metric_series: [
    { metric: "bp", window: "allTime" },
    { metric: "hrv", window: "lastYear" },
  ],
  get_glucose_panel: [{ window: "allTime" }],
  get_sleep: [{ window: "allTime" }],
  get_medication_compliance: [{ window: "allTime" }],
  get_labs: [{}],
  get_illness_recovery: [{}],
  get_workouts: [{ window: "allTime" }],
  get_cycle: [{}],
  get_correlations: [{}],
  get_metric_table: [
    { metric: "bp", window: "allTime" },
    { metric: "weight", window: "last30days", period: "yearAgo" },
    { metric: "weight", window: "last7days", period: "previous" },
    { metric: "mood", window: "lastYear", granularity: "day" },
  ],
  [SHOW_RESULT_TOOL_NAME]: [{ ref: "m1.r1" }, { ref: "m1.r2" }],
};

const FULL_SECTIONS: Record<string, unknown> = {
  bloodPressure: { aggregate: { avgSys30: 128 } },
  heartRateVariability: { aggregate: { avg30: 41 } },
  glucose: { unit: "mg/dL", byContext: {} },
  sleep: { recent: [] },
  compliance: { rate: 0.9 },
  workouts: { recent: [] },
  labs: { recent: [{ name: "LDL", analyte: "ldl" }] },
  illness: { restMode: false },
  derived: { READINESS: { value: 60 } },
  cycle: { phase: "luteal" },
  scope: { sources: ["bp", "weight", "mood", "hrv", "sleep"] },
};

async function runCase(
  name: string,
  args: Record<string, unknown>,
): Promise<{ reason?: string; reads: Read[] }> {
  reads.length = 0;
  const result = await executeCoachTool({
    userId: "u1",
    name,
    rawArguments: JSON.stringify(args),
    fallbackWindow: "allTime",
    reach: REACH,
    turn: {
      conversationId: "c1",
      locale: "en",
      priorResults: PRIOR,
      refs: createResultRefAllocator(),
      now: NOW,
    },
  });
  return { reason: result.reason, reads: [...reads] };
}

describe("every Coach tool honours the lookback limit", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  });

  it("has a case for every tool the model is offered", () => {
    const offered = COACH_TOOL_DEFS.map((def) => def.name).sort();
    expect(offered.length).toBeGreaterThan(0);
    expect(offered).toEqual(
      [...COACH_TOOL_NAMES, SHOW_RESULT_TOOL_NAME].sort(),
    );
    expect(Object.keys(CASES).sort()).toEqual(offered);
  });

  for (const [label, present] of [
    ["with every section present", FULL_SECTIONS],
    ["with nothing in the window (the empty-read path)", {}],
  ] as const) {
    it(`reads nothing older than the limit, ${label}`, async () => {
      sections = present;
      let checkedReads = 0;
      let refusals = 0;
      for (const [name, argSets] of Object.entries(CASES)) {
        for (const args of argSets) {
          const outcome = await runCase(name, args);
          const where = `${name} ${JSON.stringify(args)}`;
          const bad = outcome.reads.filter((read) => !read.ok);
          expect(bad, `${where} read past the limit`).toEqual([]);
          if (outcome.reads.length === 0) {
            // Nothing read: only an explicit refusal is an answer.
            expect(outcome.reason, `${where} made no read`).toBe(
              "outside_reach",
            );
            refusals += 1;
          }
          checkedReads += outcome.reads.length;
        }
      }
      expect(checkedReads).toBeGreaterThan(0);
      // The refusals are the cycle tool (it predicts from every cycle), the
      // stored all-time table, and the year-ago and previous-period tables
      // that do not fit into 30 days.
      expect(refusals).toBeGreaterThan(0);
    });
  }
});

// ── The source ─────────────────────────────────────────────────────────

const ROOT = join(__dirname, "../../../../..");
const COACH_DIR = join(ROOT, "src/lib/ai/coach");
const MCP_DIR = join(ROOT, "src/lib/mcp");
const SOURCE_SNAPSHOT_FILE = "source-snapshot.ts";

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__" || entry === "eval") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** `source` without its comments, so a doc mention is not read as a call. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** The argument text of every call to `fn(` in `source`, parentheses balanced. */
function callArguments(raw: string, fn: string): string[] {
  const source = code(raw);
  const out: string[] = [];
  const pattern = new RegExp(`\\b${fn}\\s*\\(`, "g");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    // Skip the declaration itself.
    const before = source.slice(Math.max(0, match.index - 20), match.index);
    if (/function\s+$/.test(before)) continue;
    let depth = 1;
    let i = match.index + match[0].length;
    const start = i;
    while (i < source.length && depth > 0) {
      if (source[i] === "(") depth += 1;
      else if (source[i] === ")") depth -= 1;
      i += 1;
    }
    out.push(source.slice(start, i - 1));
  }
  return out;
}

describe("the source hands the limit on", () => {
  it("passes the limit in every dispatch branch of the executor", () => {
    const source = readFileSync(join(COACH_DIR, "tools/executor.ts"), "utf8");
    const dispatch = source.slice(
      source.indexOf("async function dispatchRead("),
    );
    const branches = [
      ...dispatch.matchAll(
        /case\s+"(get_[a-z_]+)"\s*:\s*return\s+[A-Za-z]+\s*\(([\s\S]*?)\)\s*;/g,
      ),
    ];
    expect(branches.length).toBe(COACH_TOOL_NAMES.length);
    for (const [, name, args] of branches) {
      expect(args, `${name} does not pass reach`).toMatch(/\breach\b/);
    }
  });

  it("passes the limit to every Coach snapshot build", () => {
    // `source-snapshot.ts` is the single-metric build only MCP asks for
    // (`sourceSnapshot: true`); MCP reads without the Coach's limit, so that
    // file is checked the other way round below.
    const calls = walk(COACH_DIR)
      .filter((file) => !file.endsWith(SOURCE_SNAPSHOT_FILE))
      .flatMap((file) => {
        const source = readFileSync(file, "utf8");
        return ["buildCoachSnapshot", "resolveSnapshotPrelude"].flatMap((fn) =>
          callArguments(source, fn).map((args) => ({
            file: `${file.slice(ROOT.length + 1)} ${fn}`,
            args,
          })),
        );
      });
    expect(
      calls.filter((c) => c.file.endsWith("resolveSnapshotPrelude")).length,
    ).toBeGreaterThan(0);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.args, `${call.file} builds without a limit`).toMatch(
        /\breach\b/,
      );
    }
  });

  it("keeps the MCP single-metric build unlimited", () => {
    const source = readFileSync(join(COACH_DIR, SOURCE_SNAPSHOT_FILE), "utf8");
    const calls = ["buildCoachSnapshot", "resolveSnapshotPrelude"].flatMap(
      (fn) => callArguments(source, fn),
    );
    expect(calls.length).toBeGreaterThan(0);
    for (const args of calls) expect(args).not.toMatch(/\breach\b/);
  });

  it("passes the limit from the chat loop and nowhere from MCP", () => {
    const loop = callArguments(
      readFileSync(join(COACH_DIR, "tools/loop.ts"), "utf8"),
      "executeCoachTool",
    );
    expect(loop.length).toBeGreaterThan(0);
    for (const args of loop) expect(args).toMatch(/\breach\b/);

    const mcp = walk(MCP_DIR).flatMap((file) =>
      callArguments(readFileSync(file, "utf8"), "executeCoachTool"),
    );
    expect(mcp.length).toBeGreaterThan(0);
    for (const args of mcp) expect(args).not.toMatch(/\breach\b/);
  });
});
