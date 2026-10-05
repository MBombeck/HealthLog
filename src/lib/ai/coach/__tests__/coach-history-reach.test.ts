/**
 * The Coach lookback limit, piece by piece: the window arithmetic, the
 * numbers the settings text states, the probe's `outside_reach` (which names
 * no figure), the rule the model is given for it, and the DATA INVENTORY row.
 * The executor-wide guard is `coach-history-reach-guard.test.ts`; the real
 * readers against Postgres are `tests/integration/coach-history-reach.test.ts`.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const groupBy = vi.fn();
const findFirst = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: {
      groupBy: (args: unknown) => groupBy(args),
      findFirst: (args: unknown) => findFirst(args),
    },
  },
}));
vi.mock("@/lib/tz/resolver", () => ({
  resolveUserTimezone: () => Promise.resolve("UTC"),
}));

import {
  COACH_ALL_TIME_TABLE_DAYS,
  COACH_DAILY_DETAIL_DAYS,
  COACH_HISTORY_WINDOWS,
  HISTORY_REACH_DAYS,
  UNBOUNDED_REACH,
  capDays,
  clampWindow,
  fitsReach,
  lookbackText,
  reachCacheToken,
  reachFromPrefs,
  withinReach,
} from "@/lib/ai/coach/history-reach";
import { windowToDays } from "@/lib/ai/coach/snapshot-series";
import { resolveTableRange } from "@/lib/ai/coach/results/metric-table-tool";
import { snapshotCacheKey } from "@/lib/ai/coach/snapshot-cache";
import { coachDefaultWindowEnum } from "@/lib/validations/coach-prefs";
import { buildToolModeAddendum } from "@/lib/ai/coach/tools/system-addendum";
import { resolveEmptyRead } from "@/lib/ai/coach/tools/availability";
import {
  renderDataInventory,
  type CoachDataInventory,
} from "@/lib/ai/coach/tools/inventory";

const NOW = new Date("2026-10-04T12:00:00Z");
const NINETY = reachFromPrefs({ defaultWindow: "last90days" });

describe("the lookback arithmetic", () => {
  it("offers exactly the stored enum, narrowest first, all time last", () => {
    expect([...COACH_HISTORY_WINDOWS]).toEqual(coachDefaultWindowEnum.options);
    expect(COACH_HISTORY_WINDOWS.at(-1)).toBe("allTime");
    expect(reachFromPrefs({ defaultWindow: "allTime" })).toEqual(
      UNBOUNDED_REACH,
    );
    expect(reachFromPrefs(null)).toEqual(UNBOUNDED_REACH);
  });

  it("clamps a wider window to the limit and leaves a narrower one", () => {
    expect(clampWindow("allTime", NINETY)).toBe("last90days");
    expect(clampWindow("lastYear", NINETY)).toBe("last90days");
    expect(clampWindow("last7days", NINETY)).toBe("last7days");
    expect(clampWindow("allTime", UNBOUNDED_REACH)).toBe("allTime");
  });

  it("shortens a fixed window and drops a block that does not fit", () => {
    expect(capDays(180, NINETY)).toBe(90);
    expect(capDays(30, NINETY)).toBe(30);
    expect(capDays(180, UNBOUNDED_REACH)).toBe(180);
    expect(fitsReach(42, NINETY)).toBe(true);
    expect(fitsReach(365, NINETY)).toBe(false);
    expect(fitsReach(10_000, UNBOUNDED_REACH)).toBe(true);
    expect(
      withinReach(new Date(NOW.getTime() - 89 * 86_400_000), NINETY, NOW),
    ).toBe(true);
    expect(
      withinReach(new Date(NOW.getTime() - 91 * 86_400_000), NINETY, NOW),
    ).toBe(false);
  });

  it("keys a limited snapshot apart and leaves an unlimited key as it was", () => {
    const scope = { window: "last30days" as const, sources: ["bp" as const] };
    expect(snapshotCacheKey("u1", scope)).toBe("u1|last30days|bp");
    expect(snapshotCacheKey("u1", scope, UNBOUNDED_REACH)).toBe(
      "u1|last30days|bp",
    );
    expect(snapshotCacheKey("u1", scope, NINETY)).toBe(
      "u1|last30days|bp|reach90",
    );
    expect(reachCacheToken(undefined)).toBe("");
  });
});

describe("the numbers the settings text states", () => {
  it("are the numbers the readers use", () => {
    for (const window of ["last7days", "last30days", "last90days"] as const) {
      expect(HISTORY_REACH_DAYS[window]).toBe(windowToDays(window));
    }
    expect(HISTORY_REACH_DAYS.lastYear).toBe(windowToDays("lastYear"));
    // All time reads a year in daily detail ...
    expect(windowToDays("allTime")).toBe(COACH_DAILY_DETAIL_DAYS);
    // ... and an all-time table reaches back the stated number of years.
    const range = resolveTableRange({
      window: "allTime",
      period: "current",
      timeZone: "UTC",
      now: NOW,
    });
    const spanDays =
      Math.floor((NOW.getTime() - range.from.getTime()) / 86_400_000) + 1;
    expect(spanDays).toBe(COACH_ALL_TIME_TABLE_DAYS);
  });

  it("phrases each option with those numbers", () => {
    expect(lookbackText("last90days")).toEqual({
      optionParams: { days: 90 },
      detailKey: "detailDays",
      detailParams: { days: 90 },
    });
    expect(lookbackText("lastYear").detailParams).toEqual({ months: 12 });
    expect(lookbackText("allTime").detailParams).toEqual({
      dailyMonths: 12,
      years: 10,
      labMonths: 12,
    });
  });
});

describe("a history beyond the limit", () => {
  beforeEach(() => {
    groupBy.mockReset();
    findFirst.mockReset();
  });

  it("is reported as outside_reach with no figure from it", async () => {
    groupBy.mockResolvedValue([]);
    findFirst.mockResolvedValue({ id: "old-row" });
    const result = await resolveEmptyRead({
      userId: "u1",
      domain: "weight",
      subject: { kind: "measurement", types: ["WEIGHT"] },
      searchedWindow: "last90days",
      reach: NINETY,
      now: NOW,
    });
    expect(result).toEqual({
      present: false,
      reason: "outside_reach",
      searchedWindow: "last90days",
    });
    // The in-limit probe asked only for rows inside the limit; the existence
    // check asked only for rows before it.
    const groupWhere = groupBy.mock.calls[0][0].where;
    expect(groupWhere.measuredAt.gte.getTime()).toBe(
      NOW.getTime() - 90 * 86_400_000,
    );
    const firstWhere = findFirst.mock.calls[0][0].where;
    expect(firstWhere.measuredAt.lt.getTime()).toBe(
      NOW.getTime() - 90 * 86_400_000,
    );
  });

  it("is plain no_data when nothing older exists either", async () => {
    groupBy.mockResolvedValue([]);
    findFirst.mockResolvedValue(null);
    const result = await resolveEmptyRead({
      userId: "u1",
      domain: "weight",
      subject: { kind: "measurement", types: ["WEIGHT"] },
      searchedWindow: "last90days",
      reach: NINETY,
      now: NOW,
    });
    expect(result.reason).toBe("no_data");
  });

  it("is not looked for without a limit (MCP, the default)", async () => {
    groupBy.mockResolvedValue([]);
    const result = await resolveEmptyRead({
      userId: "u1",
      domain: "weight",
      subject: { kind: "measurement", types: ["WEIGHT"] },
      searchedWindow: "last90days",
      now: NOW,
    });
    expect(result.reason).toBe("no_data");
    expect(findFirst).not.toHaveBeenCalled();
    expect(groupBy.mock.calls[0][0].where.measuredAt).toBeUndefined();
  });
});

describe("what the model is told", () => {
  it("gives outside_reach its own rule, in English and German", () => {
    for (const locale of ["en", "de"] as const) {
      const text = buildToolModeAddendum(locale);
      expect(text).toMatch(/"outside_reach"|„outside_reach"/);
    }
    expect(buildToolModeAddendum("en")).toContain("Coach settings");
    expect(buildToolModeAddendum("de")).toContain("Coach-Einstellungen");
  });

  it("marks a domain beyond the limit in the inventory without figures", () => {
    const inventory: CoachDataInventory = {
      entries: [
        {
          tool: "get_metric_series",
          metric: "weight",
          domain: "weight",
          present: false,
          availability: { state: "outside_reach", reachableWithWindow: null },
        },
      ],
      restMode: false,
      cycleEnabled: false,
      window: "last90days",
      lookbackLimit: "last90days",
      probeScope: { window: "last90days" },
    };
    const text = renderDataInventory(inventory);
    expect(text).toContain("Lookback limit: last90days.");
    const line = text.split("\n").find((l) => l.startsWith("- weight:"));
    expect(line).toBe(
      '- weight: BEYOND LOOKBACK → get_metric_series (metric:"weight")',
    );
  });
});
