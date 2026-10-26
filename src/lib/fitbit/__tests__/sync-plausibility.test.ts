/**
 * `upsertFitbitMeasurements` is the single write seam for every Fitbit
 * resource leg — activity, sleep, daily metrics — and it holds Prisma
 * directly, so it does not inherit the shared reconciler's gate. These cases
 * pin that the provider's numbers clear the app's own declared plausibility
 * band before any of them can become a row, and that a refusal is reported.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { findManyMock, createManyMock, updateMock } = vi.hoisted(() => ({
  findManyMock: vi.fn(async () => [] as unknown[]),
  createManyMock: vi.fn<
    () => Promise<Array<{ id: string; type: string; measuredAt: Date }>>
  >(async () => []),
  updateMock: vi.fn(async () => ({})),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: {
      findMany: findManyMock,
      createManyAndReturn: createManyMock,
      update: updateMock,
    },
  },
}));
vi.mock("@/lib/crypto", () => ({ encrypt: vi.fn(), decrypt: vi.fn() }));
vi.mock("@/lib/integrations/status", () => ({
  isReauthRequired: vi.fn(async () => false),
  recordSyncFailure: vi.fn(async () => {}),
  recordSyncSuccess: vi.fn(async () => {}),
}));
vi.mock("@/lib/rollups/measurement-rollups", () => ({
  collapseToTypeDayKeys: vi.fn(() => []),
  recomputeBucketsForMeasurement: vi.fn(async () => {}),
  recomputeUserRollups: vi.fn(async () => {}),
}));
vi.mock("@/lib/insights/status-invalidation", () => ({
  invalidateStatusInsightsForTypes: vi.fn(async () => {}),
}));
vi.mock("@/lib/integrations/oauth-refresh", () => ({
  persistRotatedToken: vi.fn(async () => {}),
}));
vi.mock("../credentials", () => ({
  getUserFitbitCredentials: vi.fn(async () => null),
}));
vi.mock("../oauth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../oauth")>();
  return {
    ...actual,
    fitbitOAuth: { ...actual.fitbitOAuth, refresh: vi.fn() },
  };
});

import { eventStorage } from "@/lib/logging/context";
import { WideEventBuilder } from "@/lib/logging/event-builder";
import { RANGE_REJECTED_META_KEY } from "@/lib/measurements/plausibility-gate";
import type { RangeRejectionTally } from "@/lib/measurements/plausibility-gate";

import { upsertFitbitMeasurements } from "../sync-core";

/** RESTING_HEART_RATE is declared 25–220. */
const REAL_READING = {
  type: "RESTING_HEART_RATE",
  value: 58,
  unit: "bpm",
  measuredAt: new Date("2026-07-08T00:00:00.000Z"),
  externalId: "rhr:2026-07-08",
};

const IMPOSSIBLE_READING = {
  type: "RESTING_HEART_RATE",
  value: 4_915_200,
  unit: "bpm",
  measuredAt: new Date("2026-07-09T00:00:00.000Z"),
  externalId: "rhr:2026-07-09",
};

let event: WideEventBuilder;

function tally(): RangeRejectionTally | undefined {
  return event.toJSON().meta?.[RANGE_REJECTED_META_KEY] as
    RangeRejectionTally | undefined;
}

beforeEach(() => {
  findManyMock.mockReset().mockResolvedValue([]);
  createManyMock.mockReset().mockResolvedValue([]);
  updateMock.mockReset().mockResolvedValue({});
  event = new WideEventBuilder("background");
});

describe("upsertFitbitMeasurements — plausibility gate", () => {
  it("writes a reading inside the metric's declared band", async () => {
    createManyMock.mockResolvedValue([
      {
        id: "row-1",
        type: "RESTING_HEART_RATE",
        measuredAt: REAL_READING.measuredAt,
      },
    ]);

    const result = await eventStorage.run(event, () =>
      upsertFitbitMeasurements("user-1", [REAL_READING], { deferRollup: true }),
    );

    expect(result.imported).toBe(1);
    const planned = (createManyMock.mock.calls[0] as unknown[])[0] as {
      data: Array<{ value: number }>;
    };
    expect(planned.data).toHaveLength(1);
    expect(planned.data[0]!.value).toBe(58);
    expect(tally()).toBeUndefined();
  });

  it("refuses an out-of-band reading and annotates the drop", async () => {
    createManyMock.mockResolvedValue([
      {
        id: "row-1",
        type: "RESTING_HEART_RATE",
        measuredAt: REAL_READING.measuredAt,
      },
    ]);

    const result = await eventStorage.run(event, () =>
      upsertFitbitMeasurements("user-1", [REAL_READING, IMPOSSIBLE_READING], {
        deferRollup: true,
      }),
    );

    expect(result.imported).toBe(1);
    const planned = (createManyMock.mock.calls[0] as unknown[])[0] as {
      data: Array<{ value: number; externalId: string }>;
    };
    expect(planned.data).toHaveLength(1);
    expect(planned.data[0]!.externalId).toBe("rhr:2026-07-08");
    // The refused reading never even reached the existence probe.
    expect(
      (
        (findManyMock.mock.calls[0] as unknown[])[0] as {
          where: { externalId: { in: string[] } };
        }
      ).where.externalId.in,
    ).toEqual(["rhr:2026-07-08"]);
    expect(tally()).toEqual({
      total: 1,
      buckets: [
        {
          source: "fitbit",
          type: "RESTING_HEART_RATE",
          direction: "above_max",
          count: 1,
        },
      ],
    });
    expect(event.getLevel()).toBe("warn");
  });

  it("does not overwrite a stored reading with an out-of-band one", async () => {
    // The key already exists; ungated, the update branch rewrote its value.
    findManyMock.mockResolvedValue([
      {
        id: "existing",
        type: "RESTING_HEART_RATE",
        externalId: "rhr:2026-07-09",
        value: 58,
        unit: "bpm",
        measuredAt: IMPOSSIBLE_READING.measuredAt,
        sleepStage: null,
        deletedAt: null,
      },
    ]);

    const result = await eventStorage.run(event, () =>
      upsertFitbitMeasurements("user-1", [IMPOSSIBLE_READING], {
        deferRollup: true,
      }),
    );

    expect(result.imported).toBe(0);
    expect(updateMock).not.toHaveBeenCalled();
    expect(createManyMock).not.toHaveBeenCalled();
    expect(tally()?.total).toBe(1);
  });
});
