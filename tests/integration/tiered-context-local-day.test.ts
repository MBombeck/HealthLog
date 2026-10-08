/**
 * v1.42 — the tiered context's live day band buckets on the reader's own
 * calendar day, including on a daylight-saving changeover.
 *
 * For a reader far from UTC the 14–30-day band is read live, bucketed by
 * `date_trunc('day', <local wall clock>)`. `measured_at` is a `timestamp`
 * without time zone holding UTC, and the band read it with a single
 * `AT TIME ZONE tz`, which interprets the value as local time and converts
 * the wrong way: in Los Angeles every reading moved sixteen hours, and an
 * evening reading was summarised as the next day. The Coach and the briefing
 * then quoted a day's mean built from two different days.
 *
 * 2026-03-08 is the US changeover (02:00 PST becomes 03:00 PDT). Two weight
 * readings on that local day, 08:00 PDT (15:00Z) and 23:30 PDT (06:30Z on
 * the 9th), must form one bucket for the 8th.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

import { buildTieredSeries } from "@/lib/rollups/tiered-context";

const prisma = getPrismaClient();
const USER = "tiered-context-local-day";
const TZ = "America/Los_Angeles";
/** "Now" for the band arithmetic: the 8th sits inside the 14–30-day band. */
const NOW = new Date("2026-03-25T12:00:00Z").getTime();

beforeAll(async () => {
  await truncateAllTables(prisma);
  await prisma.user.create({
    data: { id: USER, username: USER, timezone: TZ },
  });
  await prisma.measurement.createMany({
    data: [
      { at: "2026-03-08T15:00:00Z", value: 70 },
      { at: "2026-03-09T06:30:00Z", value: 80 },
      // A reading on the local 7th, late evening PST, for contrast.
      { at: "2026-03-08T07:30:00Z", value: 90 },
    ].map(({ at, value }) => ({
      userId: USER,
      type: "WEIGHT" as const,
      value,
      unit: "kg",
      measuredAt: new Date(at),
      source: "MANUAL" as const,
    })),
  });
});

describe("tiered context — live day band on the reader's calendar", () => {
  it("puts an evening reading on its own local day across the DST changeover", async () => {
    const series = await buildTieredSeries(USER, "WEIGHT", {
      tz: TZ,
      now: NOW,
      skipEnsureFresh: true,
    });
    const byDay = Object.fromEntries(
      series.dayBand.map((b) => [b.bucketStart.slice(0, 10), b]),
    );
    expect(Object.keys(byDay).sort()).toEqual(["2026-03-07", "2026-03-08"]);
    expect(byDay["2026-03-08"]).toMatchObject({ count: 2, mean: 75 });
    expect(byDay["2026-03-07"]).toMatchObject({ count: 1, mean: 90 });
  });
});
