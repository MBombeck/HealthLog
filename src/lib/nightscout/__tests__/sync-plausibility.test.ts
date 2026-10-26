/**
 * The Nightscout pull writes BLOOD_GLUCOSE rows directly, so it does not
 * inherit the shared reconciler's gate. It is also first-write-wins: a row
 * that lands here is immutable, so an impossible sample never corrects itself
 * on a later pass. These cases pin the refusal and its annotation.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  upsertMock,
  findManyMock,
  emitArrivalsMock,
  recomputeMock,
  invalidateMock,
} = vi.hoisted(() => ({
  upsertMock: vi.fn(),
  findManyMock: vi.fn(),
  emitArrivalsMock: vi.fn(),
  recomputeMock: vi.fn(),
  invalidateMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: { measurement: { upsert: upsertMock, findMany: findManyMock } },
}));

vi.mock("@/lib/arrivals/measurement-emit", () => ({
  emitInsertedMeasurementArrivals: emitArrivalsMock,
}));

vi.mock("@/lib/rollups/measurement-rollups", () => ({
  collapseToTypeDayKeys: (rows: Array<{ type: string; measuredAt: Date }>) =>
    rows.map((r) => ({ type: r.type, measuredAt: r.measuredAt })),
  recomputeBucketsForMeasurement: recomputeMock,
  recomputeBucketsForKeys: recomputeMock,
}));

vi.mock("@/lib/insights/status-invalidation", () => ({
  invalidateStatusInsightsForTypes: invalidateMock,
}));

import { eventStorage } from "@/lib/logging/context";
import { WideEventBuilder } from "@/lib/logging/event-builder";
import { RANGE_REJECTED_META_KEY } from "@/lib/measurements/plausibility-gate";
import type { RangeRejectionTally } from "@/lib/measurements/plausibility-gate";

import { upsertNightscoutEntries } from "../sync";

/** BLOOD_GLUCOSE is declared 20–800 mg/dL. */
const REAL_ENTRY = { id: "abc", sgv: 112, date: 1718000000000 };
/** A sensor fault, or an mg/dL field carrying something else entirely. */
const IMPOSSIBLE_ENTRY = { id: "def", sgv: 41_600, date: 1718000300000 };

let event: WideEventBuilder;

function tally(): RangeRejectionTally | undefined {
  return event.toJSON().meta?.[RANGE_REJECTED_META_KEY] as
    RangeRejectionTally | undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  findManyMock.mockResolvedValue([]);
  upsertMock.mockResolvedValue({ id: "row-1" });
  emitArrivalsMock.mockResolvedValue(undefined);
  recomputeMock.mockResolvedValue(undefined);
  invalidateMock.mockResolvedValue(undefined);
  event = new WideEventBuilder("background");
});

describe("upsertNightscoutEntries — plausibility gate", () => {
  it("writes a reading inside the metric's declared band", async () => {
    const result = await eventStorage.run(event, () =>
      upsertNightscoutEntries("user-1", [REAL_ENTRY]),
    );

    expect(result).toEqual({ inserted: 1, failedRows: 0 });
    expect(upsertMock).toHaveBeenCalledTimes(1);
    expect(tally()).toBeUndefined();
  });

  it("refuses an out-of-band reading and annotates the drop", async () => {
    const result = await eventStorage.run(event, () =>
      upsertNightscoutEntries("user-1", [REAL_ENTRY, IMPOSSIBLE_ENTRY]),
    );

    expect(result).toEqual({ inserted: 1, failedRows: 0 });
    expect(upsertMock).toHaveBeenCalledTimes(1);
    expect(
      (upsertMock.mock.calls[0]![0] as { create: { value: number } }).create
        .value,
    ).toBe(112);
    expect(tally()).toEqual({
      total: 1,
      buckets: [
        {
          source: "nightscout",
          type: "BLOOD_GLUCOSE",
          direction: "above_max",
          count: 1,
        },
      ],
    });
    expect(event.getLevel()).toBe("warn");
  });

  it("writes nothing when the whole page is out of band", async () => {
    const result = await eventStorage.run(event, () =>
      upsertNightscoutEntries("user-1", [IMPOSSIBLE_ENTRY]),
    );

    expect(result).toEqual({ inserted: 0, failedRows: 0 });
    expect(upsertMock).not.toHaveBeenCalled();
    expect(tally()?.total).toBe(1);
  });
});
