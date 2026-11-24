/**
 * The one session rule, read and written (#1414).
 *
 * An Apple Health export stores a workout the iPhone app already synced under
 * its own key. The reads count the pair once through `workoutSessionKey`; the
 * writes find the pair through the same function and fold the export row into
 * the HealthKit one. These tests pin that the two sides agree, what a fold
 * keeps, and that migration 0562 fills the same columns in SQL.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type {
  MeasurementSource,
  PrismaClient,
} from "@/generated/prisma/client";
import {
  pickCanonicalWorkoutRows,
  workoutSessionKey,
} from "@/lib/measurements/pick-canonical-workout-rows";

import {
  exportRowsOf,
  FOLDED_WORKOUT_COLUMNS,
  foldedWorkoutValues,
  foldExportCopiesInto,
  healthKitRowOf,
  isAppleHealthExportKey,
  isHealthKitWorkout,
  readAppleHealthSessionRows,
  type StoredSessionRow,
} from "../export-healthkit-twins";

const START = new Date("2026-08-21T16:36:16.000Z");

/** The one delegate the probe reads, answering with `rows`. */
function reader(
  findMany: () => Promise<StoredSessionRow[]>,
): Pick<PrismaClient, "workout"> {
  return { workout: { findMany } } as unknown as Pick<PrismaClient, "workout">;
}

type FoldTx = Parameters<typeof foldExportCopiesInto>[0];

function stored(
  overrides: Partial<StoredSessionRow> & { id: string },
): StoredSessionRow {
  return {
    source: "APPLE_HEALTH" as MeasurementSource,
    externalId: null,
    sportType: "walking",
    startedAt: START,
    durationSec: 3316,
    createdAt: new Date("2026-09-01T00:00:00Z"),
    totalEnergyKcal: null,
    totalDistanceM: null,
    avgHeartRate: null,
    minHeartRate: null,
    maxHeartRate: null,
    stepCount: null,
    elevationM: null,
    pauseDurationSec: null,
    externalSourceVersion: null,
    route: null,
    samples: null,
    insight: null,
    ...overrides,
  };
}

describe("workoutSessionKey", () => {
  const base = {
    source: "APPLE_HEALTH" as MeasurementSource,
    sportType: "walking",
    startedAt: START,
    durationSec: 3316,
  };

  it("is one key for the same source, sport, start and duration", () => {
    expect(workoutSessionKey(base)).toBe(
      workoutSessionKey({ ...base, startedAt: new Date(START.getTime()) }),
    );
  });

  it.each([
    ["source", { source: "STRAVA" as MeasurementSource }],
    ["sport", { sportType: "running" }],
    ["start, by a millisecond", { startedAt: new Date(START.getTime() + 1) }],
    ["duration, by a second", { durationSec: 3317 }],
  ])("differs when the %s differs", (_, change) => {
    expect(workoutSessionKey({ ...base, ...change })).not.toBe(
      workoutSessionKey(base),
    );
  });

  it("identifies nothing without a duration", () => {
    expect(workoutSessionKey({ ...base, durationSec: undefined })).toBeNull();
  });
});

describe("the reads and the writes agree on a pair", () => {
  const healthKit = stored({
    id: "hk",
    externalId: "6C1E6A0F-0D4B-4C2F-9F0A-6E3B2D1C0A9F",
    createdAt: new Date("2026-08-21T18:00:00Z"),
    avgHeartRate: 118,
  });
  const exported = stored({
    id: "ex",
    externalId: "workout:0123456789abcdef0123456789ab",
    createdAt: new Date("2026-11-18T09:00:00Z"),
    totalEnergyKcal: 240,
  });

  it("the read keeps one of the two", () => {
    expect(pickCanonicalWorkoutRows([healthKit, exported])).toHaveLength(1);
  });

  it("the write probe groups the two under the read's key", async () => {
    const findMany = vi.fn(async () => [healthKit, exported]);
    const groups = await readAppleHealthSessionRows(reader(findMany), "u1", [
      {
        source: "APPLE_HEALTH",
        sportType: "walking",
        startedAt: START,
        durationSec: 3316,
      },
    ]);
    const group = groups.get(workoutSessionKey(healthKit)!);
    expect(group?.map((row) => row.id)).toEqual(["hk", "ex"]);
    expect(healthKitRowOf(group)?.id).toBe("hk");
    expect(exportRowsOf(group).map((row) => row.id)).toEqual(["ex"]);
  });

  it("the write probe leaves out a row the read would keep apart", async () => {
    const other = stored({
      id: "other",
      externalId: "workout:ffff",
      durationSec: 3317,
    });
    const groups = await readAppleHealthSessionRows(
      reader(async () => [healthKit, other]),
      "u1",
      [
        {
          source: "APPLE_HEALTH",
          sportType: "walking",
          startedAt: START,
          durationSec: 3316,
        },
      ],
    );
    expect(
      groups.get(workoutSessionKey(healthKit)!)?.map((row) => row.id),
    ).toEqual(["hk"]);
  });

  it("asks only about Apple Health sessions", async () => {
    const findMany = vi.fn(async (): Promise<StoredSessionRow[]> => []);
    await readAppleHealthSessionRows(reader(findMany), "u1", [
      {
        source: "STRAVA",
        sportType: "walking",
        startedAt: START,
        durationSec: 3316,
      },
    ]);
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe("which side is which", () => {
  it("reads an export key by its prefix", () => {
    expect(isAppleHealthExportKey("workout:abc")).toBe(true);
    expect(isAppleHealthExportKey("sample:abc")).toBe(true);
    expect(isAppleHealthExportKey("6C1E6A0F-0D4B")).toBe(false);
    expect(isAppleHealthExportKey(null)).toBe(false);
  });

  it("takes an Apple Health row with any other key as the phone's", () => {
    expect(
      isHealthKitWorkout({ source: "APPLE_HEALTH", externalId: "6C1E" }),
    ).toBe(true);
    expect(
      isHealthKitWorkout({ source: "APPLE_HEALTH", externalId: "workout:a" }),
    ).toBe(false);
    expect(isHealthKitWorkout({ source: "APPLE_HEALTH", externalId: "" })).toBe(
      false,
    );
    expect(isHealthKitWorkout({ source: "STRAVA", externalId: "6C1E" })).toBe(
      false,
    );
  });
});

describe("foldedWorkoutValues", () => {
  it("fills only what the kept row leaves empty, from the oldest copy that states it", () => {
    expect(
      foldedWorkoutValues({ avgHeartRate: 118, totalEnergyKcal: null }, [
        { totalEnergyKcal: null, totalDistanceM: 4100, avgHeartRate: 120 },
        { totalEnergyKcal: 240, totalDistanceM: 4200 },
      ]),
    ).toEqual({ totalEnergyKcal: 240, totalDistanceM: 4100 });
  });

  it("changes nothing on a complete row", () => {
    const full = Object.fromEntries(
      FOLDED_WORKOUT_COLUMNS.map((column) => [
        column,
        column === "externalSourceVersion" ? "1" : 1,
      ]),
    );
    expect(foldedWorkoutValues(full, [{ ...full, avgHeartRate: 2 }])).toEqual(
      {},
    );
  });
});

describe("foldExportCopiesInto", () => {
  function fakeTx() {
    return {
      workout: { update: vi.fn(), deleteMany: vi.fn() },
      workoutRoute: { update: vi.fn() },
      workoutSamples: { update: vi.fn() },
      workoutInsight: { update: vi.fn() },
      personalRecord: { updateMany: vi.fn() },
    };
  }

  it("moves what the HealthKit row lacks, fills it, re-points records and deletes the copy", async () => {
    const tx = fakeTx();
    const kept = stored({
      id: "hk",
      externalId: "HK-1",
      avgHeartRate: 118,
      samples: { id: "s-hk" },
    });
    const copy = stored({
      id: "ex",
      externalId: "workout:a",
      totalEnergyKcal: 240,
      avgHeartRate: 121,
      route: { id: "r-ex" },
      samples: { id: "s-ex" },
      insight: { id: "i-ex" },
    });
    expect(
      await foldExportCopiesInto(
        tx as unknown as FoldTx,
        "u1",
        kept,
        [copy],
        [{ totalDistanceM: 4100 }],
      ),
    ).toBe(true);
    expect(tx.workoutRoute.update).toHaveBeenCalledWith({
      where: { workoutId: "ex" },
      data: { workoutId: "hk" },
    });
    // The HealthKit row's own series stays.
    expect(tx.workoutSamples.update).not.toHaveBeenCalled();
    expect(tx.workoutInsight.update).toHaveBeenCalledWith({
      where: { workoutId: "ex" },
      data: { workoutId: "hk" },
    });
    expect(tx.workout.update).toHaveBeenCalledWith({
      where: { id: "hk" },
      data: { totalEnergyKcal: 240, totalDistanceM: 4100 },
    });
    expect(tx.personalRecord.updateMany).toHaveBeenCalledWith({
      where: {
        userId: "u1",
        source: "APPLE_HEALTH",
        externalId: { in: ["workout:a"] },
      },
      data: { externalId: "HK-1" },
    });
    expect(tx.workout.deleteMany).toHaveBeenCalledWith({
      where: { userId: "u1", id: { in: ["ex"] } },
    });
    // The caller's copy now says what the row holds.
    expect(kept).toMatchObject({
      totalEnergyKcal: 240,
      totalDistanceM: 4100,
      avgHeartRate: 118,
      route: { id: "r-ex" },
    });
  });

  it("writes nothing when there is no copy and nothing to fill", async () => {
    const tx = fakeTx();
    const kept = stored({ id: "hk", externalId: "HK-1", avgHeartRate: 118 });
    expect(
      await foldExportCopiesInto(
        tx as unknown as FoldTx,
        "u1",
        kept,
        [],
        [{ avgHeartRate: 120 }],
      ),
    ).toBe(false);
    expect(tx.workout.update).not.toHaveBeenCalled();
    expect(tx.workout.deleteMany).not.toHaveBeenCalled();
  });
});

describe("migration 0562 folds the same columns", () => {
  it("fills every folded column and no other", () => {
    const sql = readFileSync(
      join(
        process.cwd(),
        "prisma/migrations/0562_apple_health_workout_export_pairs/migration.sql",
      ),
      "utf8",
    );
    const filled = [...sql.matchAll(/"(\w+)" = coalesce\(k\."(\w+)"/g)].map(
      (m) => {
        expect(m[1]).toBe(m[2]);
        return m[1];
      },
    );
    const snake = FOLDED_WORKOUT_COLUMNS.map((column) =>
      column.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`),
    );
    // A non-empty match set first: a pattern that matched nothing would agree
    // with an empty list.
    expect(filled.length).toBeGreaterThan(0);
    expect(filled.sort()).toEqual([...snake].sort());
  });
});
