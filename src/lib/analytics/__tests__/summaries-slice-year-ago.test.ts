/**
 * The year-ago baseline of the summaries slice (`avg30LastYear`) reads the
 * DAY buckets of every type in one statement.
 *
 * It used to read them one type at a time, four at once, so a fifteen-type
 * account sent fifteen statements in four waves on every cold slice. The
 * guard here: one read whatever the number of types, each type composed from
 * its own canonical-source buckets as the per-type read composed it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: { measurementRollup: { findMany: vi.fn() } },
}));
vi.mock("@/lib/rollups/measurement-read", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rollups/measurement-read")>()),
  loadUserSourcePriority: vi.fn(async () => null),
}));

import { prisma } from "@/lib/db";
import { loadUserSourcePriority } from "@/lib/rollups/measurement-read";

import { computeAvg30LastYearMap } from "../summaries-slice-passes";

const FIND = prisma.measurementRollup.findMany as unknown as ReturnType<
  typeof vi.fn
>;
const NOW = Date.UTC(2026, 9, 23, 12);
const DAY = 86_400_000;

function bucket(
  type: string,
  source: string,
  daysAgo: number,
  count: number,
  mean: number,
) {
  const bucketStart = new Date(NOW - daysAgo * DAY);
  bucketStart.setUTCHours(0, 0, 0, 0);
  return {
    type,
    source,
    bucketStart,
    count,
    mean,
    minValue: mean - 1,
    maxValue: mean + 1,
  };
}

beforeEach(() => {
  FIND.mockReset();
  vi.mocked(loadUserSourcePriority).mockClear();
});

describe("computeAvg30LastYearMap", () => {
  it("reads every type in one statement", async () => {
    FIND.mockResolvedValue([]);
    const types = Array.from({ length: 15 }, (_, i) => `TYPE_${i}`);
    const out = await computeAvg30LastYearMap("user-1", types, NOW, null);
    expect(FIND).toHaveBeenCalledTimes(1);
    const where = FIND.mock.calls[0][0].where;
    expect(where.type.in).toEqual(types);
    expect(where.granularity).toBe("DAY");
    expect(where.bucketStart.gte.getTime()).toBeLessThan(
      where.bucketStart.lt.getTime(),
    );
    expect([...out.keys()]).toEqual(types);
    expect([...out.values()].every((v) => v === null)).toBe(true);
  });

  it("keeps one source per day and composes each type on its own", async () => {
    FIND.mockResolvedValue([
      // Weight on one day from two sources: the ladder keeps Withings.
      bucket("WEIGHT", "MANUAL", 380, 1, 90),
      bucket("WEIGHT", "WITHINGS", 380, 1, 80),
      bucket("WEIGHT", "WITHINGS", 379, 3, 82),
      bucket("BLOOD_PRESSURE_SYS", "WITHINGS", 381, 2, 130),
    ]);
    const out = await computeAvg30LastYearMap(
      "user-1",
      ["BLOOD_PRESSURE_SYS", "WEIGHT", "BODY_FAT"],
      NOW,
      null,
    );
    expect(out.get("WEIGHT")).toBeCloseTo((80 + 3 * 82) / 4, 10);
    expect(out.get("BLOOD_PRESSURE_SYS")).toBe(130);
    expect(out.get("BODY_FAT")).toBeNull();
  });

  it("reads nothing for no types, and loads the ladder only when asked", async () => {
    expect((await computeAvg30LastYearMap("user-1", [], NOW)).size).toBe(0);
    expect(FIND).not.toHaveBeenCalled();
    FIND.mockResolvedValue([bucket("WEIGHT", "WITHINGS", 380, 1, 80)]);
    await computeAvg30LastYearMap("user-1", ["WEIGHT"], NOW);
    expect(loadUserSourcePriority).toHaveBeenCalledTimes(1);
  });
});
