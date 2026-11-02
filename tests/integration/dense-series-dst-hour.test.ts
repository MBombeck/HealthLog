/**
 * Hour buckets of a dense series across a clock change, pinned to fixed
 * dates so the case runs every day rather than only when the rolling window
 * happens to cover one. A fall-back night repeats a local hour: both of its
 * instances are their own bucket, each the mean of its own readings. A zone
 * half an hour off UTC starts its buckets on the half hour.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { readDenseSeries } from "@/lib/measurements/dense-series-read";
import { seriesRowsFrom } from "@/lib/measurements/series-canonical";

import { makeUser } from "../kit/factories";
import { getPrismaClient, truncateAllTables } from "./setup";

const prisma = getPrismaClient();

let userId = "";

// New York falls back on 2026-11-01 at 06:00 UTC: 01:00-02:00 local runs
// once as EDT (05:00-06:00 UTC) and once as EST (06:00-07:00 UTC).
const READINGS: Array<[string, number]> = [
  ["2026-11-01T04:30:00.000Z", 5],
  ["2026-11-01T05:10:00.000Z", 6],
  ["2026-11-01T05:50:00.000Z", 8],
  ["2026-11-01T06:10:00.000Z", 10],
  ["2026-11-01T06:40:00.000Z", 12],
  ["2026-11-01T07:20:00.000Z", 9],
];

async function read(userTz: string) {
  const since = new Date("2026-11-01T00:00:00.000Z");
  const { bucketRows } = await readDenseSeries({
    userId,
    type: "BLOOD_GLUCOSE",
    grain: "hour",
    userTz,
    since,
    seriesRows: seriesRowsFrom(null, "BLOOD_GLUCOSE", since),
  });
  return bucketRows.map((r) => [r.bucket_start.toISOString(), r.mean]);
}

describe("dense-series hour buckets across a clock change", () => {
  beforeAll(async () => {
    await truncateAllTables(prisma);
    userId = (await makeUser({ timezone: "America/New_York" })).id;
    await prisma.measurement.createMany({
      data: READINGS.map(([at, value]) => ({
        userId,
        type: "BLOOD_GLUCOSE" as const,
        source: "NIGHTSCOUT" as const,
        value,
        unit: "mg/dL",
        measuredAt: new Date(at),
      })),
    });
  });

  it("keeps both instances of the repeated local hour apart", async () => {
    expect(await read("America/New_York")).toEqual([
      ["2026-11-01T04:00:00.000Z", 5],
      ["2026-11-01T05:00:00.000Z", 7],
      ["2026-11-01T06:00:00.000Z", 11],
      ["2026-11-01T07:00:00.000Z", 9],
    ]);
  });

  it("starts the hours of a half-hour zone on the half hour", async () => {
    expect(await read("Asia/Kolkata")).toEqual([
      ["2026-11-01T04:30:00.000Z", 5.5],
      ["2026-11-01T05:30:00.000Z", 9],
      ["2026-11-01T06:30:00.000Z", 10.5],
    ]);
  });
});
