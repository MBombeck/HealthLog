/**
 * What a provider's measurement write costs in statements, first written and
 * read again, against a real Postgres.
 *
 * Every provider below once wrote its readings one at a time through
 * `reconcileExternalMeasurement`: about eight statements a reading on the
 * first write and ten on a re-read, and a candidate read that walked the
 * account's rows whenever the planner did not know the account yet. A
 * history backfill was quadratic in its length. They write through
 * `reconcileExternalMeasurements` now, which settles a batch in sets; the
 * budgets here are what that costs, with room, and far below the old cost.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { upsertGarminMeasurements } from "@/lib/garmin/sync";
import { upsertOuraMeasurements } from "@/lib/oura/sync";
import { upsertPolarMeasurements } from "@/lib/polar/sync";
import { upsertWhoopMeasurements } from "@/lib/whoop/sync-core";

import { makeUser } from "../kit/factories";
import { countStatements, summariseStatements } from "./query-counter";
import { getPrismaClient, truncateAllTables } from "./setup";

vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: vi.fn(() => null),
}));

const prisma = getPrismaClient();
const DAYS = 120;
const DAY_MS = 86_400_000;
const START = Date.parse("2026-01-01T12:00:00.000Z");

/** Five readings a day for `DAYS` days: daily values and four sleep stages. */
function readings(value: number) {
  const out = [];
  for (let d = 0; d < DAYS; d++) {
    const at = new Date(START + d * DAY_MS);
    out.push({
      type: "ACTIVITY_STEPS",
      value: value * 1000,
      unit: "steps",
      measuredAt: at,
      externalId: `day:${d}:steps`,
    });
    for (const sleepStage of ["CORE", "DEEP", "REM", "AWAKE"] as const) {
      out.push({
        type: "SLEEP_DURATION",
        value,
        unit: "min",
        measuredAt: new Date(at.getTime() - 6 * 3_600_000),
        externalId: `day:${d}:sleep:${sleepStage}`,
        sleepStage,
      });
    }
  }
  return out;
}

const PROVIDERS = {
  garmin: upsertGarminMeasurements,
  oura: upsertOuraMeasurements,
  polar: upsertPolarMeasurements,
  whoop: upsertWhoopMeasurements,
} as const;

beforeEach(async () => {
  await truncateAllTables(prisma);
});

describe.each(Object.entries(PROVIDERS))("%s measurement write", (_, write) => {
  it("costs a fraction of a statement a reading first, and about one on a re-read", async () => {
    const userId = (await makeUser()).id;
    const first = await countStatements(() => write(userId, readings(30)));
    const rows = await prisma.measurement.count({ where: { userId } });
    expect(rows).toBe(DAYS * 5);
    expect(first.result).toBe(rows);
    expect(
      first.count,
      summariseStatements(first.statements).slice(0, 2_000),
    ).toBeLessThanOrEqual(rows / 4);

    // A changed value on every reading: each is the reconciler's overwrite.
    const again = await countStatements(() => write(userId, readings(31)));
    expect(again.result).toBe(rows);
    expect(await prisma.measurement.count({ where: { userId } })).toBe(rows);
    expect(
      await prisma.measurement.count({ where: { userId, value: 31 } }),
    ).toBe(DAYS * 4);
    expect(
      again.count,
      summariseStatements(again.statements).slice(0, 2_000),
    ).toBeLessThanOrEqual(rows * 1.5);
  });
});
