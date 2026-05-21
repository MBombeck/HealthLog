/**
 * v1.4.39 W-SUM — unit tests for the cumulative-day-sum reader helpers.
 *
 * `prisma.measurementRollup.findMany` is mocked so the tests pin the
 * exact `where` shape the consumer sends (cumulative type set,
 * granularity, since-bound) and the legacy-NULL fallback semantics of
 * `resolveBucketSum`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    measurementRollup: {
      findMany: mocks.findMany,
    },
  },
}));

import { prisma } from "@/lib/db";
import {
  isCumulativeType,
  readCumulativeDaySums,
  resolveBucketSum,
} from "../measurement-read-cumulative";

beforeEach(() => {
  mocks.findMany.mockReset();
});

describe("isCumulativeType", () => {
  it("recognises the five cumulative HK types", () => {
    expect(isCumulativeType("ACTIVITY_STEPS")).toBe(true);
    expect(isCumulativeType("ACTIVE_ENERGY_BURNED")).toBe(true);
    expect(isCumulativeType("FLIGHTS_CLIMBED")).toBe(true);
    expect(isCumulativeType("WALKING_RUNNING_DISTANCE")).toBe(true);
    expect(isCumulativeType("TIME_IN_DAYLIGHT")).toBe(true);
  });

  it("rejects spot metrics", () => {
    expect(isCumulativeType("WEIGHT")).toBe(false);
    expect(isCumulativeType("BLOOD_PRESSURE_SYS")).toBe(false);
    expect(isCumulativeType("PULSE")).toBe(false);
  });
});

describe("readCumulativeDaySums", () => {
  it("queries the rollup table with the cumulative type + DAY granularity", async () => {
    const since = new Date("2026-04-15T00:00:00.000Z");
    const rows = [
      {
        bucketStart: new Date("2026-04-15T00:00:00.000Z"),
        sumValue: 8120,
        count: 4,
        mean: 2030,
      },
      {
        bucketStart: new Date("2026-04-16T00:00:00.000Z"),
        sumValue: 12480,
        count: 5,
        mean: 2496,
      },
    ];
    mocks.findMany.mockResolvedValueOnce(rows);

    const out = await readCumulativeDaySums("user-1", "ACTIVITY_STEPS", since);

    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      bucketStart: new Date("2026-04-15T00:00:00.000Z"),
      sumValue: 8120,
      count: 4,
      mean: 2030,
    });
    // Single round-trip — eliminates the legacy per-type chunked
    // findMany loop in analytics A2.
    expect(prisma.measurementRollup.findMany).toHaveBeenCalledTimes(1);
    const args = mocks.findMany.mock.calls[0][0];
    expect(args.where).toMatchObject({
      userId: "user-1",
      type: "ACTIVITY_STEPS",
      granularity: "DAY",
      bucketStart: { gte: since },
    });
    expect(args.orderBy).toEqual({ bucketStart: "asc" });
  });

  it("propagates legacy NULL sum_value rows so the caller can fall back", async () => {
    mocks.findMany.mockResolvedValueOnce([
      {
        bucketStart: new Date("2026-04-15T00:00:00.000Z"),
        sumValue: null,
        count: 3,
        mean: 1500,
      },
    ]);

    const [row] = await readCumulativeDaySums(
      "user-1",
      "ACTIVITY_STEPS",
      new Date("2026-04-15T00:00:00.000Z"),
    );
    expect(row.sumValue).toBeNull();
    // Algebraic fallback parity: pre-v1.4.39 buckets still surface
    // a usable daily total during the boot-backfill convergence
    // window.
    expect(resolveBucketSum(row)).toBe(4500);
  });
});

describe("resolveBucketSum", () => {
  it("returns sumValue when populated", () => {
    expect(
      resolveBucketSum({
        bucketStart: new Date(),
        sumValue: 7500,
        count: 3,
        mean: 2500,
      }),
    ).toBe(7500);
  });

  it("falls back to mean * count when sumValue is null (legacy row)", () => {
    expect(
      resolveBucketSum({
        bucketStart: new Date(),
        sumValue: null,
        count: 3,
        mean: 2500,
      }),
    ).toBe(7500);
  });
});
