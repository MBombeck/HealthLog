/**
 * #1023 — the deferred-rollup ledger of a backfill cycle holds type-days, not
 * readings.
 *
 * On a full-history backfill every write defers its rollup fold to one pass at
 * the end of the cycle, and the cycle-wide ledger used to keep one entry per
 * written reading. A per-minute heart-rate history of two and a half years is
 * 1.3 M readings over about 900 days, so the ledger alone grew with the stream
 * for the whole walk. It now keeps one entry per touched `(type, UTC day)`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { findManyMock, createManyMock } = vi.hoisted(() => ({
  findManyMock: vi.fn(async () => [] as unknown[]),
  createManyMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: {
      findMany: findManyMock,
      createManyAndReturn: createManyMock,
      update: vi.fn(),
    },
  },
}));
vi.mock("@/lib/crypto", () => ({ encrypt: vi.fn(), decrypt: vi.fn() }));
vi.mock("@/lib/integrations/status", () => ({
  isReauthRequired: vi.fn(async () => false),
  recordSyncFailure: vi.fn(async () => {}),
  recordSyncSuccess: vi.fn(async () => {}),
}));
vi.mock("@/lib/insights/status-invalidation", () => ({
  invalidateStatusInsightsForTypes: vi.fn(async () => {}),
}));
vi.mock("@/lib/arrivals/measurement-emit", () => ({
  emitInsertedMeasurementArrivals: vi.fn(async () => {}),
}));
vi.mock("../credentials", () => ({
  getUserGoogleHealthCredentials: vi.fn(async () => null),
}));

import {
  runWithGoogleHealthSyncCycle,
  upsertGoogleHealthMeasurements,
} from "../sync-core";

const DAYS = 3;
const PER_DAY = 1440;
const START = Date.parse("2026-09-01T00:00:00.000Z");

beforeEach(() => {
  findManyMock.mockReset().mockResolvedValue([]);
  createManyMock
    .mockReset()
    .mockImplementation(
      async (args: { data: Array<{ type: string; measuredAt: Date }> }) =>
        args.data.map((d, i) => ({
          id: `row-${i}`,
          type: d.type,
          measuredAt: d.measuredAt,
        })),
    );
});

describe("deferred rollup ledger on a dense backfill", () => {
  it("keeps one key per touched type-day however many readings land", async () => {
    const cycle = await runWithGoogleHealthSyncCycle(async () => {
      for (let day = 0; day < DAYS; day++) {
        const readings = [];
        for (let m = 0; m < PER_DAY; m++) {
          const at = new Date(START + day * 86_400_000 + m * 60_000);
          readings.push({
            type: "PULSE",
            value: 60,
            unit: "bpm",
            measuredAt: at,
            externalId: `${at.toISOString()}:hr`,
          });
        }
        await upsertGoogleHealthMeasurements("dense-user", readings, {
          deferRollup: true,
        });
      }
      return null;
    });

    expect(cycle.deferredRollupKeys).toHaveLength(DAYS);
    expect(
      cycle.deferredRollupKeys.map((k) => k.measuredAt.toISOString()).sort(),
    ).toEqual([
      "2026-09-01T00:00:00.000Z",
      "2026-09-02T00:00:00.000Z",
      "2026-09-03T00:00:00.000Z",
    ]);
  });
});
