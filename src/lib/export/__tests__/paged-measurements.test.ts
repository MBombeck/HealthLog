import { describe, expect, it, vi } from "vitest";
import {
  reconstructSleepSessions,
  type SleepStageRow,
} from "@/lib/analytics/sleep-night";
import {
  groupMeasurementPagesForExport,
  iterateMeasurementPages,
} from "../paged-measurements";

function row(id: string, measuredAt: string) {
  return { id, measuredAt: new Date(measuredAt) };
}

describe("iterateMeasurementPages", () => {
  it("yields bounded keyset pages without retaining them in one result", async () => {
    const first = [
      row("m-3", "2026-07-21T12:00:00.000Z"),
      row("m-2", "2026-07-21T12:00:00.000Z"),
    ];
    const second = [row("m-1", "2026-07-20T12:00:00.000Z")];
    const findMany = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const db = { measurement: { findMany } };

    const iterator = iterateMeasurementPages(
      db as never,
      { userId: "user-1" },
      { id: true, measuredAt: true },
      2,
    )[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: first,
    });
    expect(findMany).toHaveBeenCalledTimes(1);
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: second,
    });
    expect(findMany).toHaveBeenCalledTimes(2);
    await expect(iterator.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
    expect(findMany).toHaveBeenNthCalledWith(1, {
      where: { userId: "user-1" },
      orderBy: [{ measuredAt: "desc" }, { id: "desc" }],
      take: 2,
      select: { id: true, measuredAt: true },
    });
    expect(findMany).toHaveBeenNthCalledWith(2, {
      where: { userId: "user-1" },
      orderBy: [{ measuredAt: "desc" }, { id: "desc" }],
      take: 2,
      cursor: { id: "m-2" },
      skip: 1,
      select: { id: true, measuredAt: true },
    });
  });

  it("does not yield an empty terminal page after a full page", async () => {
    const full = [
      row("m-2", "2026-07-21T12:00:00.000Z"),
      row("m-1", "2026-07-20T12:00:00.000Z"),
    ];
    const findMany = vi
      .fn()
      .mockResolvedValueOnce(full)
      .mockResolvedValueOnce([]);
    const db = { measurement: { findMany } };

    const pages = [];
    for await (const page of iterateMeasurementPages(
      db as never,
      {},
      { id: true, measuredAt: true },
      2,
    )) {
      pages.push(page);
    }

    expect(pages).toEqual([full]);
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it("propagates a database failure after releasing the prior page", async () => {
    const failure = new Error("page two failed");
    const findMany = vi
      .fn()
      .mockResolvedValueOnce([
        row("m-2", "2026-07-21T12:00:00.000Z"),
        row("m-1", "2026-07-20T12:00:00.000Z"),
      ])
      .mockRejectedValueOnce(failure);
    const db = { measurement: { findMany } };
    const iterator = iterateMeasurementPages(
      db as never,
      {},
      { id: true, measuredAt: true },
      2,
    )[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({ done: false });
    await expect(iterator.next()).rejects.toBe(failure);
  });

  it("stops querying when the consumer cancels after one page", async () => {
    const findMany = vi
      .fn()
      .mockResolvedValue([
        row("m-2", "2026-07-21T12:00:00.000Z"),
        row("m-1", "2026-07-20T12:00:00.000Z"),
      ]);
    const db = { measurement: { findMany } };
    const iterator = iterateMeasurementPages(
      db as never,
      {},
      { id: true, measuredAt: true },
      2,
    )[Symbol.asyncIterator]();

    await iterator.next();
    await iterator.return?.();

    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it("keeps a sleep wake-day carry intact across database page boundaries", async () => {
    const newer = {
      type: "WEIGHT",
      value: 80,
      measuredAt: new Date("2026-07-21T09:00:00.000Z"),
    };
    const rem = {
      type: "SLEEP_DURATION",
      value: 60,
      measuredAt: new Date("2026-07-21T08:00:00.000Z"),
    };
    const deep = {
      type: "SLEEP_DURATION",
      value: 60,
      measuredAt: new Date("2026-07-21T07:00:00.000Z"),
    };
    const older = {
      type: "WEIGHT",
      value: 79,
      measuredAt: new Date("2026-07-20T00:00:00.000Z"),
    };
    async function* pages() {
      yield [newer, rem];
      yield [deep, older];
    }

    const groups = [];
    for await (const group of groupMeasurementPagesForExport(
      pages(),
      "UTC",
      "night",
    )) {
      groups.push(group);
    }

    expect(groups).toEqual([[newer], [rem, deep], [older]]);
  });

  it("keeps a contiguous cross-midnight stage together across pages", async () => {
    const crossMidnight = {
      type: "SLEEP_DURATION",
      value: 240,
      measuredAt: new Date("2026-07-21T02:00:00.000Z"),
      sleepStage: "CORE" as const,
    };
    const precedingStage = {
      type: "SLEEP_DURATION",
      value: 60,
      measuredAt: new Date("2026-07-20T22:00:00.000Z"),
      sleepStage: "DEEP" as const,
    };
    const older = {
      type: "WEIGHT",
      value: 80,
      measuredAt: new Date("2026-07-19T12:00:00.000Z"),
    };
    const sleepRows: SleepStageRow[] = [crossMidnight, precedingStage];
    expect(reconstructSleepSessions(sleepRows, "UTC")).toHaveLength(1);

    async function* pages() {
      yield [crossMidnight];
      yield [precedingStage, older];
    }

    const groups = [];
    for await (const group of groupMeasurementPagesForExport(
      pages(),
      "UTC",
      "night",
    )) {
      groups.push(group);
    }

    expect(groups).toEqual([[crossMidnight, precedingStage], [older]]);
  });
});
