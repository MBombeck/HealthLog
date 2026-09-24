import { describe, expect, it, vi } from "vitest";

import {
  bucketRowsByDay,
  iterateDayBuckets,
  iterateSourcePages,
  runConsolidation,
  type ConsolidationParams,
} from "../consolidation-base";
import type { PerSampleRow } from "../consolidation-tz";
import type {
  MeasurementType,
  Prisma,
  PrismaClient,
} from "@/generated/prisma/client";

// The consolidation drains walk a user's whole history of a type. Issue #1031:
// on an account with 1.25 million rows the walk gathered every page into one
// array before folding a single day (≈230 MB of heap for the heart-rate type
// alone) and paged with a cursor Postgres could not use as an index condition,
// so every page re-read the rows before it. These tests pin the three
// properties the fix rests on: pages are handed on one at a time and a day is
// folded before the scan reads past it, the cursor carries an index-usable
// bound, and a pass stops cleanly when asked to.

/** A deterministic per-sample row at `index` hours past 2026-01-01T00:00Z. */
function row(index: number, minuteOffset = 0): PerSampleRow {
  return {
    id: `m-${String(index).padStart(4, "0")}`,
    type: "ACTIVITY_STEPS",
    value: index,
    measuredAt: new Date(Date.UTC(2026, 0, 1, index, minuteOffset, 0)),
    externalId: `hk-uuid-${index}`,
  };
}

interface CursorWhere {
  AND?: [
    Prisma.MeasurementWhereInput,
    { measuredAt?: { gte?: Date } },
    { OR?: Array<{ measuredAt?: Date | { gt?: Date }; id?: { gt?: string } }> },
  ];
}

/**
 * A findMany mock that serves `allRows` in keyset order, honouring `take` and
 * the `(measuredAt, id)` cursor the pager AND-combines onto the base where.
 */
function buildPagingFindMany(allRows: PerSampleRow[]) {
  const ordered = [...allRows].sort((a, b) => {
    const byTime = a.measuredAt.getTime() - b.measuredAt.getTime();
    return byTime !== 0 ? byTime : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return vi.fn(
    async (args: { where: CursorWhere; take?: number; orderBy?: unknown }) => {
      const take = args.take ?? ordered.length;
      const and = args.where.AND;
      if (!and) return ordered.slice(0, take);
      const gte = and[1].measuredAt?.gte?.getTime();
      const or = and[2].OR ?? [];
      const gt = (
        or[0]?.measuredAt as { gt?: Date } | undefined
      )?.gt?.getTime();
      const tieId = or[1]?.id?.gt;
      return ordered
        .filter((r) => {
          const t = r.measuredAt.getTime();
          if (gte !== undefined && t < gte) return false;
          return t > gt! || (t === gt! && r.id > tieId!);
        })
        .slice(0, take);
    },
  );
}

function mockClient(findMany: ReturnType<typeof vi.fn>): PrismaClient {
  return { measurement: { findMany } } as unknown as PrismaClient;
}

const BASE_WHERE: Prisma.MeasurementWhereInput = {
  userId: "user-1",
  type: "ACTIVITY_STEPS",
};
const SELECT: Prisma.MeasurementSelect = {
  id: true,
  type: true,
  value: true,
  measuredAt: true,
  externalId: true,
};

async function collectPages(
  pages: AsyncIterable<PerSampleRow[]>,
): Promise<PerSampleRow[][]> {
  const out: PerSampleRow[][] = [];
  for await (const page of pages) out.push(page);
  return out;
}

describe("iterateSourcePages", () => {
  it("yields every row once, in keyset order, one bounded page at a time", async () => {
    const all = Array.from({ length: 23 }, (_, i) => row(i));
    const findMany = buildPagingFindMany(all);

    const pages = await collectPages(
      iterateSourcePages(mockClient(findMany), BASE_WHERE, SELECT, 10),
    );

    expect(pages.map((p) => p.length)).toEqual([10, 10, 3]);
    expect(pages.flat().map((r) => r.id)).toEqual(all.map((r) => r.id));
    expect(findMany).toHaveBeenCalledTimes(3);
  });

  it("issues exactly one extra probing page when the row count is an exact multiple of the page size", async () => {
    const all = Array.from({ length: 20 }, (_, i) => row(i));
    const findMany = buildPagingFindMany(all);

    const pages = await collectPages(
      iterateSourcePages(mockClient(findMany), BASE_WHERE, SELECT, 10),
    );

    expect(pages.flat()).toHaveLength(20);
    expect(findMany).toHaveBeenCalledTimes(3);
  });

  it("yields nothing when the first page is empty", async () => {
    const findMany = buildPagingFindMany([]);
    const pages = await collectPages(
      iterateSourcePages(mockClient(findMany), BASE_WHERE, SELECT, 10),
    );
    expect(pages).toEqual([]);
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it("bounds every later page with an index-usable measuredAt >= cursor conjunct", async () => {
    // `measuredAt > c OR (measuredAt = c AND id > i)` alone is not an index
    // condition: Postgres walked the index from the user's first row on
    // every page. The redundant `>=` bound is what the planner can use.
    const all = Array.from({ length: 12 }, (_, i) => row(i));
    const findMany = buildPagingFindMany(all);

    await collectPages(
      iterateSourcePages(mockClient(findMany), BASE_WHERE, SELECT, 5),
    );

    expect(findMany.mock.calls[0]?.[0]?.where).toEqual(BASE_WHERE);
    const second = findMany.mock.calls[1]?.[0]?.where as CursorWhere;
    expect(second.AND?.[0]).toEqual(BASE_WHERE);
    expect(second.AND?.[1]).toEqual({
      measuredAt: { gte: row(4).measuredAt },
    });
    expect(second.AND?.[2]).toEqual({
      OR: [
        { measuredAt: { gt: row(4).measuredAt } },
        { measuredAt: row(4).measuredAt, id: { gt: row(4).id } },
      ],
    });
    for (const call of findMany.mock.calls) {
      expect(call[0]?.orderBy).toEqual([{ measuredAt: "asc" }, { id: "asc" }]);
    }
  });

  it("resumes past rows that share the boundary instant without gaps or duplicates", async () => {
    // Five rows on the same instant straddle the page boundary.
    const all = [0, 1, 2, 3, 4].map((i) => ({
      ...row(i),
      measuredAt: new Date("2026-05-16T08:00:00.000Z"),
    }));
    const findMany = buildPagingFindMany(all);
    const pages = await collectPages(
      iterateSourcePages(mockClient(findMany), BASE_WHERE, SELECT, 2),
    );
    expect(pages.flat().map((r) => r.id)).toEqual(all.map((r) => r.id));
  });
});

describe("iterateDayBuckets", () => {
  const days = [
    { ...row(1), measuredAt: new Date("2026-05-16T08:00:00.000Z") },
    { ...row(2), measuredAt: new Date("2026-05-16T14:00:00.000Z") },
    {
      ...row(3),
      externalId: "stats:HKQuantityTypeIdentifierStepCount:2026-05-16",
      measuredAt: new Date("2026-05-16T15:00:00.000Z"),
    },
    { ...row(4), measuredAt: new Date("2026-05-17T06:00:00.000Z") },
    { ...row(5), measuredAt: new Date("2026-05-17T20:00:00.000Z") },
    { ...row(6), measuredAt: new Date("2026-05-18T09:00:00.000Z") },
  ];

  it("groups exactly as the whole-array bucketing does, stats rows skipped", async () => {
    const findMany = buildPagingFindMany(days);
    let scanned = 0;
    const streamed = new Map<string, string[]>();
    for await (const [key, rows] of iterateDayBuckets(
      iterateSourcePages(mockClient(findMany), BASE_WHERE, SELECT, 2),
      "Europe/Berlin",
      "stats:",
      () => {
        scanned += 1;
      },
    )) {
      streamed.set(
        key,
        rows.map((r) => r.id),
      );
    }

    const baseline = bucketRowsByDay(days, "Europe/Berlin", "stats:");
    expect([...streamed.keys()]).toEqual([...baseline.keys()]);
    for (const [key, rows] of baseline) {
      expect(streamed.get(key)).toEqual(rows.map((r) => r.id));
    }
    expect(scanned).toBe(days.length);
  });

  it("hands a day on before the scan reads the page after the one that closed it", async () => {
    const findMany = buildPagingFindMany(days);
    const pagesReadWhenYielded: number[] = [];
    for await (const _day of iterateDayBuckets(
      iterateSourcePages(mockClient(findMany), BASE_WHERE, SELECT, 2),
      "Europe/Berlin",
      "stats:",
    )) {
      pagesReadWhenYielded.push(findMany.mock.calls.length);
    }
    // Pages: [r1 r2] [r3 r4] [r5 r6] [] — 05-16 closes on page 2 (r4),
    // 05-17 on page 3 (r6), 05-18 at the end of the scan.
    expect(pagesReadWhenYielded).toEqual([2, 3, 4]);
  });
});

describe("runConsolidation — streamed walk", () => {
  /** One row per hour for `dayCount` UTC days. */
  function hourlyRows(dayCount: number): PerSampleRow[] {
    return Array.from({ length: dayCount * 24 }, (_, i) => row(i, 30));
  }

  function params(
    findMany: ReturnType<typeof vi.fn>,
    writeDay: ConsolidationParams<MeasurementType>["writeDay"],
    shouldStop?: () => boolean,
  ): ConsolidationParams<MeasurementType> {
    const client = {
      user: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ id: "user-1", timezone: "UTC" }]),
      },
      measurement: { findMany },
    } as unknown as PrismaClient;
    return {
      prismaClient: client,
      options: { shouldStop },
      types: ["ACTIVITY_STEPS"] as MeasurementType[],
      hkIdentifierForType: () => "HKQuantityTypeIdentifierStepCount",
      dailyStatsExternalId: (hk: string, day: string) => `stats:${hk}:${day}`,
      statsPrefix: "stats:",
      reduce: (rows: readonly PerSampleRow[]) => rows.length,
      buildScanWhere: () => BASE_WHERE,
      writeDay,
      recordBucket: () => {},
    };
  }

  it("folds the first day before the scan has read the whole history", async () => {
    // 500 days × 24 rows = 12 000 rows → default pages of 5000, 5000, 2000.
    const all = hourlyRows(500);
    const findMany = buildPagingFindMany(all);
    const pagesReadAtFirstWrite: number[] = [];
    const writeDay = vi.fn(async () => {
      if (pagesReadAtFirstWrite.length === 0) {
        pagesReadAtFirstWrite.push(findMany.mock.calls.length);
      }
      return { kind: "written" as const, sourceRowsRemoved: 0 };
    });

    const result = await runConsolidation(params(findMany, writeDay));

    expect(writeDay).toHaveBeenCalledTimes(500);
    expect(findMany).toHaveBeenCalledTimes(3);
    // The old walk read all three pages before the first write.
    expect(pagesReadAtFirstWrite).toEqual([1]);
    expect(result.stoppedEarly).toBe(false);
  });

  it("stops before the next day once shouldStop answers true, and reads no further", async () => {
    const all = hourlyRows(500);
    const findMany = buildPagingFindMany(all);
    const writeDay = vi.fn(async () => ({
      kind: "written" as const,
      sourceRowsRemoved: 0,
    }));
    let budget = 3;
    const shouldStop = () => budget-- <= 0;

    const result = await runConsolidation(
      params(findMany, writeDay, shouldStop),
    );

    expect(writeDay).toHaveBeenCalledTimes(3);
    expect(result.stoppedEarly).toBe(true);
    expect(findMany).toHaveBeenCalledTimes(1);
  });
});
