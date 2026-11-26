/**
 * The user's source-priority blob is read once per request, whichever reader
 * asks for it and however many ask at once. A digest request reached it from
 * the day readers, the rollup readers and the status readers; each went to
 * the database on its own, and Prisma batched whichever of them happened to
 * land in the same tick, so the statement count of the route changed from run
 * to run.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { findUnique, readDayAggregates } = vi.hoisted(() => ({
  findUnique: vi.fn(async () => ({ sourcePriorityJson: { heartRate: [] } })),
  readDayAggregates: vi.fn(async () => []),
}));
vi.mock("@/lib/db", () => ({ prisma: { user: { findUnique } } }));
vi.mock("@/lib/measurements/day-aggregates", () => ({ readDayAggregates }));

import { eventStorage } from "@/lib/logging/context";
import { WideEventBuilder } from "@/lib/logging/event-builder";
import { loadUserSourcePriority } from "@/lib/rollups/measurement-read";
import { readLatestDayMean } from "@/lib/insights/derived/coincident-deviation";

function inEvent<T>(kind: "http" | "background", fn: () => Promise<T>) {
  return eventStorage.run(new WideEventBuilder(kind), fn);
}

describe("loadUserSourcePriority", () => {
  beforeEach(() => {
    findUnique.mockClear();
    readDayAggregates.mockClear();
  });

  it("reads once per request, for parallel and later callers alike", async () => {
    const now = new Date("2026-11-26T12:00:00Z");
    const values = await inEvent("http", async () => {
      const parallel = await Promise.all([
        loadUserSourcePriority("u1"),
        loadUserSourcePriority("u1"),
        readLatestDayMean("u1", "PULSE", 7, now, "UTC"),
        readLatestDayMean("u1", "RESTING_HEART_RATE", 7, now, "UTC"),
      ]);
      const later = await loadUserSourcePriority("u1");
      return [...parallel.slice(0, 2), later];
    });
    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(readDayAggregates).toHaveBeenCalledWith(
      expect.objectContaining({ sourcePriority: { heartRate: [] } }),
    );
    expect(values).toEqual([
      { heartRate: [] },
      { heartRate: [] },
      { heartRate: [] },
    ]);
  });

  it("keeps users apart and starts afresh with the next request", async () => {
    await inEvent("http", async () => {
      await loadUserSourcePriority("u1");
      await loadUserSourcePriority("u2");
    });
    await inEvent("http", () => loadUserSourcePriority("u1"));
    expect(findUnique).toHaveBeenCalledTimes(3);
  });

  it("reads afresh inside a background event and outside any event", async () => {
    await inEvent("background", async () => {
      await loadUserSourcePriority("u1");
      await loadUserSourcePriority("u1");
    });
    await loadUserSourcePriority("u1");
    await loadUserSourcePriority("u1");
    expect(findUnique).toHaveBeenCalledTimes(4);
  });
});
