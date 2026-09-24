/**
 * The derived-resting mint must survive its own previous runs.
 *
 * The fold deletes the raw PULSE samples a proxy user's resting figure is
 * derived from, and mints one `RESTING_HEART_RATE` / `COMPUTED` row per folded
 * day to carry that figure forward. The mint is skipped for users who already
 * have NATIVE resting rows, because the read resolver ignores the proxy for
 * them and a derived row would double-count.
 *
 * The probe that answers "does this user have native resting data?" used to
 * match every source — including the `COMPUTED` rows the mint itself had
 * written. So from the second nightly run onward it answered yes for every
 * proxy user, the mint stopped, and the fold kept tombstoning the raw readings
 * anyway: each run destroyed another day of resting history that cannot be
 * recomputed from anything still in the database.
 *
 * These tests fail on that code. The probe mock filters like the database
 * does, so the assertion is on behaviour (does the row get minted) rather than
 * on the shape of the query.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { recomputeBucketsForMeasurement } = vi.hoisted(() => ({
  recomputeBucketsForMeasurement: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/rollups/measurement-rollups", () => ({
  recomputeBucketsForMeasurement,
}));

import {
  runDenseIntradayRetention,
  DENSE_INTRADAY_RETENTION_DAYS,
} from "../dense-intraday-retention";
import type { MeasurementType, PrismaClient } from "@/generated/prisma/client";
import { candidateLookup, createManyVia } from "./hourly-mint-mock";

/** A day well outside the retention window, so the fold definitely runs. */
const FOLD_DAY = new Date(
  Date.now() - (DENSE_INTRADAY_RETENTION_DAYS + 10) * 24 * 60 * 60 * 1000,
);

/** Enough spread that the 20th-percentile resting derivation yields a value. */
function pulseRows() {
  const base = new Date(FOLD_DAY);
  base.setUTCHours(9, 0, 0, 0);
  return [58, 61, 64, 70, 88, 132, 141].map((value, i) => ({
    id: `p${i}`,
    type: "PULSE" as MeasurementType,
    value,
    measuredAt: new Date(base.getTime() + i * 5 * 60 * 1000),
    externalId: `uuid-${i}`,
    unit: "bpm",
  }));
}

/**
 * @param existingResting rows the probe reads, each with the source the row
 *   was actually written under. The mock applies the query's `source` filter
 *   the way Postgres would, so a probe that omits the filter sees them all.
 */
function buildPrismaMock(existingResting: Array<{ source: string }>) {
  const upsert = vi.fn().mockResolvedValue({ id: "minted-resting" });
  const create = vi.fn().mockResolvedValue({ id: "minted-hourly" });
  const update = vi.fn().mockResolvedValue({});
  const updateMany = vi.fn().mockResolvedValue({ count: 0 });
  const txFindFirst = vi.fn().mockResolvedValue(null);

  // The probe. Honours a `source: { not: X }` clause exactly like the DB.
  const probeFindFirst = vi.fn(
    async (args: { where: { source?: { not?: string } } }) => {
      const excluded = args.where?.source?.not;
      const match = existingResting.find((r) =>
        excluded === undefined ? true : r.source !== excluded,
      );
      return match ? { id: "native-resting" } : null;
    },
  );

  const tx = {
    measurement: {
      create,
      update,
      findFirst: txFindFirst,
      updateMany,
      upsert,
      findMany: candidateLookup(),
      createManyAndReturn: createManyVia(create),
    },
  };

  return {
    mock: {
      user: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ id: "user-1", timezone: "Europe/Berlin" }]),
      },
      measurement: {
        findMany: vi.fn(async (args: { where: { type: string } }) =>
          args.where.type === "PULSE" ? pulseRows() : [],
        ),
        findFirst: probeFindFirst,
        upsert,
      },
      $transaction: vi.fn(async (cb: (t: unknown) => Promise<unknown>) =>
        cb(tx),
      ),
    } as unknown as PrismaClient,
    upsert,
    probeFindFirst,
  };
}

function mintedRestingCalls(upsert: ReturnType<typeof vi.fn>) {
  return upsert.mock.calls.filter(
    (c) =>
      (c[0] as { create?: { type?: string } })?.create?.type ===
      "RESTING_HEART_RATE",
  );
}

beforeEach(() => {
  recomputeBucketsForMeasurement.mockClear();
});

describe("dense-intraday retention — derived resting mint", () => {
  it("still mints when the only resting rows are its OWN computed output", async () => {
    // The state after run 1: one COMPUTED row exists, no native data.
    const { mock, upsert } = buildPrismaMock([{ source: "COMPUTED" }]);

    await runDenseIntradayRetention(mock);

    // Run 2 must still mint. Before the fix the probe matched the COMPUTED
    // row, concluded "user has native resting", and skipped the mint - while
    // the fold deleted that day's raw PULSE regardless.
    expect(mintedRestingCalls(upsert).length).toBeGreaterThan(0);
  });

  it("skips the mint when the user genuinely has native resting rows", async () => {
    const { mock, upsert } = buildPrismaMock([{ source: "APPLE_HEALTH" }]);

    await runDenseIntradayRetention(mock);

    // The read resolver ignores the proxy for these users, so a derived row
    // would double-count. This is the behaviour the probe is FOR.
    expect(mintedRestingCalls(upsert)).toHaveLength(0);
  });

  it("mints for a user with no resting rows at all", async () => {
    const { mock, upsert } = buildPrismaMock([]);

    await runDenseIntradayRetention(mock);

    expect(mintedRestingCalls(upsert).length).toBeGreaterThan(0);
  });

  it("asks the database to exclude computed rows", async () => {
    // Belt and braces: the behavioural tests above rely on the mock honouring
    // the filter, so pin that the query actually carries it.
    const { mock, probeFindFirst } = buildPrismaMock([]);

    await runDenseIntradayRetention(mock);

    expect(probeFindFirst).toHaveBeenCalled();
    const where = probeFindFirst.mock.calls[0][0].where as {
      source?: { not?: string };
    };
    expect(where.source).toEqual({ not: "COMPUTED" });
  });
});
