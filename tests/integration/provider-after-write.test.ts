/**
 * The provider write step against the real schema: what a sync leaves behind
 * after `afterProviderWrite` and `afterProviderBackfill`.
 *
 *   - the touched days are folded into the DAY rollup the read paths use;
 *   - a write that touched nothing folds nothing and reports no failure;
 *   - a backfill refolds the whole touched range once, including a day that
 *     was written without the per-write fold.
 *
 * The data-arrival send and the status re-warm are queue work (the boss is
 * absent here, so the arrival send is a no-op); they are pinned by the unit
 * tests of the providers. What matters here is what Postgres holds.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  afterProviderBackfill,
  afterProviderWrite,
} from "@/lib/integrations/sync-kit/after-write";

import { makeMeasurement, makeUser } from "../kit/factories";
import { getPrismaClient, truncateAllTables } from "./setup";

beforeEach(() => truncateAllTables(getPrismaClient()));

async function dayRollups(userId: string) {
  return getPrismaClient().measurementRollup.findMany({
    where: { userId, granularity: "DAY", type: "WEIGHT" },
    select: { bucketStart: true, count: true, mean: true, source: true },
    orderBy: { bucketStart: "asc" },
  });
}

describe("provider write step", () => {
  it("folds the days a sync touched", async () => {
    const user = await makeUser();
    const first = await makeMeasurement(user, {
      source: "WITHINGS",
      value: 80,
      measuredAt: new Date("2026-03-02T07:30:00Z"),
    });
    const second = await makeMeasurement(user, {
      source: "WITHINGS",
      value: 82,
      measuredAt: new Date("2026-03-02T19:30:00Z"),
    });

    const result = await afterProviderWrite({
      userId: user.id,
      provider: "withings",
      touched: [first, second],
      evictDashboard: true,
    });

    expect(result).toEqual({ rollupFailed: false });
    const rows = await dayRollups(user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ count: 2, mean: 81, source: "WITHINGS" });
  });

  it("does nothing for a write that touched nothing", async () => {
    const user = await makeUser();
    await expect(
      afterProviderWrite({ userId: user.id, provider: "polar", touched: [] }),
    ).resolves.toEqual({ rollupFailed: false });
    expect(await dayRollups(user.id)).toEqual([]);
  });

  it("refolds a backfill's whole range once at the end", async () => {
    const user = await makeUser();
    const days = ["2026-03-01", "2026-03-04", "2026-03-09"];
    const written = [];
    for (const day of days) {
      written.push(
        await makeMeasurement(user, {
          source: "GOOGLE_HEALTH",
          value: 70,
          measuredAt: new Date(`${day}T08:00:00Z`),
        }),
      );
    }

    await afterProviderBackfill({
      userId: user.id,
      provider: "google-health",
      keys: written.map((row) => ({
        type: row.type,
        measuredAt: new Date(
          `${row.measuredAt.toISOString().slice(0, 10)}T00:00:00Z`,
        ),
      })),
    });

    const rows = await dayRollups(user.id);
    expect(
      rows.map((row) => row.bucketStart.toISOString().slice(0, 10)),
    ).toEqual(days);
  });
});
