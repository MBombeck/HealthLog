/**
 * The Coach reads lab results over the whole record, summarised (#1263).
 *
 * The labs block used to stop at twelve months whatever the lookback setting
 * said, so a slow drift in LDL or PSA across years was invisible even with
 * "All" chosen. Labs are sparse, so they now reach back over the whole record
 * while the dense readings keep their one-year daily window; a long history
 * folds into a bounded summary so the prompt stays small. A lookback limit the
 * person set still applies.
 *
 * Real Postgres, real tool executor, a heavy fixture: thirty markers measured
 * every quarter for twenty years.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import { makeUser } from "../kit/factories";
import { executeCoachTool } from "@/lib/ai/coach/tools/executor";
import { __resetCoachSnapshotCacheForTests } from "@/lib/ai/coach/snapshot";
import {
  HISTORY_REACH_DAYS,
  UNBOUNDED_REACH,
  type CoachHistoryReach,
} from "@/lib/ai/coach/history-reach";
import type { CoachLabsBlock } from "@/lib/ai/coach/labs-snapshot";

vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: vi.fn(() => null),
}));

const prisma = getPrismaClient();
const DAY = 86_400_000;
const MARKERS = 30;
const YEARS = 20;
const NOW = Date.now();

async function seedHeavyHistory(): Promise<string> {
  const user = await makeUser({ timezone: "UTC" });
  const rows = [];
  for (let m = 0; m < MARKERS; m++) {
    for (let q = 0; q < YEARS * 4; q++) {
      rows.push({
        userId: user.id,
        analyte: m === 0 ? "LDL" : `Marker ${m}`,
        // LDL climbs one unit a quarter: 100 twenty years ago, 179 now.
        value: m === 0 ? 179 - q : 50 + ((m * 7 + q) % 40),
        unit: "mg/dL",
        referenceLow: 0,
        referenceHigh: 130,
        takenAt: new Date(NOW - (q * 91 + 2) * DAY),
      });
    }
  }
  await prisma.labResult.createMany({ data: rows });
  return user.id;
}

async function readLabs(
  userId: string,
  reach: CoachHistoryReach,
  args: Record<string, unknown> = {},
): Promise<CoachLabsBlock> {
  const result = await executeCoachTool({
    userId,
    name: "get_labs",
    rawArguments: JSON.stringify(args),
    fallbackWindow: "allTime",
    reach,
  });
  expect(result.present).toBe(true);
  return (result as { data: CoachLabsBlock }).data;
}

beforeEach(async () => {
  await truncateAllTables(prisma);
  __resetCoachSnapshotCacheForTests();
});
afterEach(() => {
  __resetCoachSnapshotCacheForTests();
});

describe("the Coach labs read over a twenty-year history", () => {
  it("reads a marker last measured years ago, and keeps the overview small", async () => {
    const userId = await seedHeavyHistory();
    // A panel from six years ago and nothing since: outside the old
    // twelve-month read, inside the whole record.
    await prisma.labResult.create({
      data: {
        userId,
        analyte: "PSA",
        value: 1.4,
        unit: "ng/mL",
        takenAt: new Date(NOW - 6 * 365 * DAY),
      },
    });
    const labs = await readLabs(userId, UNBOUNDED_REACH, { analyte: "psa" });
    expect(labs.recent.map((entry) => entry.value)).toEqual([1.4]);

    // The overview (and the snapshot block it is) carries the latest value
    // per marker and no history: it shares the prompt's size cap.
    const overview = await readLabs(userId, UNBOUNDED_REACH);
    expect(overview.recent).toHaveLength(24);
    expect(overview.recent.every((entry) => !entry.history)).toBe(true);
    expect(JSON.stringify(overview).length).toBeLessThan(8_000);
  });

  it("summarises a named marker's whole history in a bounded entry", async () => {
    const userId = await seedHeavyHistory();
    const labs = await readLabs(userId, UNBOUNDED_REACH, { analyte: "LDL" });

    expect(labs.recent).toHaveLength(1);
    const ldl = labs.recent[0];
    expect(ldl.value).toBe(179);
    expect(ldl.history?.count).toBe(YEARS * 4);
    const first = Date.parse(ldl.history!.firstTakenAt);
    expect(NOW - first).toBeGreaterThan(19 * 365 * DAY);
    // The drift is readable from the yearly means: lower long ago.
    const yearly = ldl.history!.yearly;
    expect(yearly.at(-1)!.mean).toBeLessThan(yearly[0].mean);
    expect(yearly.length + ldl.history!.yearsOmitted).toBeGreaterThanOrEqual(
      YEARS - 2,
    );
    // Eighty readings, one bounded entry.
    expect(JSON.stringify(labs).length).toBeLessThan(2_000);
  });

  it("stops at the lookback limit the person set", async () => {
    const userId = await seedHeavyHistory();
    const labs = await readLabs(
      userId,
      { window: "lastYear", days: HISTORY_REACH_DAYS.lastYear },
      { analyte: "LDL" },
    );
    const ldl = labs.recent[0];
    expect(ldl.history!.count).toBeLessThanOrEqual(5);
    expect(NOW - Date.parse(ldl.history!.firstTakenAt)).toBeLessThanOrEqual(
      365 * DAY,
    );
    expect(ldl.history!.yearly).toEqual([]);
  });
});
