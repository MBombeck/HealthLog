import { describe, expect, it, vi } from "vitest";

import type { Prisma } from "@/generated/prisma/client";
import {
  reconcileExternalMeasurement,
  type ExternalMeasurementWrite,
} from "../reconcile-external-measurement";

function desired(
  overrides: Partial<ExternalMeasurementWrite> = {},
): ExternalMeasurementWrite {
  return {
    userId: "user-1",
    type: "SLEEP_DURATION",
    value: 42,
    unit: "minutes",
    source: "OURA",
    measuredAt: new Date("2026-07-20T06:30:00.000Z"),
    sleepStage: "DEEP",
    externalId: "sleep:new",
    externalSourceVersion: "v2",
    deviceType: "ring",
    ...overrides,
  };
}

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "row-1",
    userId: "user-1",
    type: "SLEEP_DURATION",
    value: 30,
    valueMin: null,
    valueMax: null,
    unit: "minutes",
    source: "OURA",
    measuredAt: new Date("2026-07-20T06:00:00.000Z"),
    notes: null,
    notesEncrypted: null,
    externalId: "sleep:new",
    externalSourceVersion: null,
    aggregationProvenance: null,
    aggregationContributorCount: null,
    aggregationSelectedSourceHash: null,
    glucoseContext: null,
    sleepStage: "DEEP",
    rhythmClassification: null,
    deviceType: "ring",
    syncVersion: 1,
    deletedAt: null,
    createdAt: new Date("2026-07-20T07:00:00.000Z"),
    updatedAt: new Date("2026-07-20T07:00:00.000Z"),
    ...overrides,
  };
}

function transaction(rows: Record<string, unknown>[]) {
  const measurement = {
    findMany: vi.fn().mockResolvedValue(rows),
    create: vi.fn(),
    update: vi.fn(),
    deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    findFirst: vi.fn().mockResolvedValue(null),
  };
  const tx = {
    measurement,
    $queryRaw: vi.fn().mockResolvedValue([]),
    $executeRawUnsafe: vi.fn().mockResolvedValue(0),
  } as unknown as Prisma.TransactionClient;
  return { tx, measurement };
}

describe("reconcileExternalMeasurement", () => {
  it("keeps the external-id row canonical when its desired natural key is occupied", async () => {
    const external = row({ id: "external-row" });
    const natural = row({
      id: "natural-row",
      externalId: "sleep:legacy",
      measuredAt: new Date("2026-07-20T06:30:00.000Z"),
    });
    const { tx, measurement } = transaction([external, natural]);
    measurement.update.mockResolvedValue(
      row({
        id: "external-row",
        value: 42,
        measuredAt: new Date("2026-07-20T06:30:00.000Z"),
        externalSourceVersion: "v2",
      }),
    );

    const verdict = await reconcileExternalMeasurement(tx, desired());
    expect(verdict).toMatchObject({
      status: "updated",
      row: { id: "external-row", externalId: "sleep:new" },
      retiredCollisionId: "natural-row",
    });
    expect(measurement.deleteMany).not.toHaveBeenCalled();
    expect(measurement.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { id: "external-row" },
        data: expect.objectContaining({
          value: 42,
          measuredAt: new Date("2026-07-20T06:30:00.000Z"),
          externalId: "sleep:new",
          externalSourceVersion: "v2",
          deviceType: "ring",
          deletedAt: null,
        }),
      }),
    );
  });

  it("retires the redundant collision as a durable tombstone", async () => {
    const external = row({ id: "external-row" });
    const natural = row({
      id: "natural-row",
      externalId: "sleep:legacy",
      measuredAt: new Date("2026-07-20T06:30:00.000Z"),
    });
    const { tx, measurement } = transaction([external, natural]);
    measurement.update
      .mockResolvedValueOnce(
        row({
          id: "natural-row",
          externalId: "sleep:legacy",
          measuredAt: new Date(0),
          deletedAt: expect.any(Date),
        }),
      )
      .mockResolvedValueOnce(
        row({
          id: "external-row",
          value: 42,
          measuredAt: new Date("2026-07-20T06:30:00.000Z"),
        }),
      );

    const verdict = await reconcileExternalMeasurement(tx, desired());

    expect(verdict).toMatchObject({
      status: "updated",
      retiredCollisionId: "natural-row",
    });
    expect(measurement.deleteMany).not.toHaveBeenCalled();
    expect(measurement.update).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: { id: "natural-row" },
        data: expect.objectContaining({
          measuredAt: new Date(0),
        }),
      }),
    );
  });

  it("resurrects a tombstoned natural-key row and adopts the desired external identity", async () => {
    const tombstone = row({
      id: "tombstone-row",
      externalId: "sleep:legacy",
      measuredAt: new Date("2026-07-20T06:30:00.000Z"),
      deletedAt: new Date("2026-07-20T08:00:00.000Z"),
    });
    const { tx, measurement } = transaction([tombstone]);
    measurement.update.mockResolvedValue(
      row({
        id: "tombstone-row",
        value: 42,
        measuredAt: new Date("2026-07-20T06:30:00.000Z"),
        deletedAt: null,
      }),
    );

    const verdict = await reconcileExternalMeasurement(tx, desired());

    expect(verdict).toMatchObject({
      status: "resurrected",
      row: { id: "tombstone-row", externalId: "sleep:new" },
    });
  });

  it("returns duplicate for an immutable exact external/natural match", async () => {
    const existing = row({
      id: "exact-row",
      measuredAt: new Date("2026-07-20T06:30:00.000Z"),
    });
    const { tx, measurement } = transaction([existing]);

    const verdict = await reconcileExternalMeasurement(tx, desired(), {
      exactExternalMatch: "duplicate",
    });

    expect(verdict).toMatchObject({
      status: "duplicate",
      row: { id: "exact-row" },
    });
    expect(measurement.update).not.toHaveBeenCalled();
    expect(measurement.deleteMany).not.toHaveBeenCalled();
  });

  it("keeps an immutable exact-match tombstone deleted", async () => {
    const tombstone = row({
      id: "deleted-sample",
      measuredAt: new Date("2026-07-20T06:30:00.000Z"),
      deletedAt: new Date("2026-07-20T08:00:00.000Z"),
    });
    const { tx, measurement } = transaction([tombstone]);

    const verdict = await reconcileExternalMeasurement(tx, desired(), {
      exactExternalMatch: "duplicate",
    });

    expect(verdict.status).toBe("duplicate");
    expect(measurement.update).not.toHaveBeenCalled();
  });

  it("keeps a higher-authority native aggregate unchanged when XML arrives later", async () => {
    const native = row({
      id: "native-stats",
      type: "ACTIVITY_STEPS",
      value: 8_600,
      unit: "steps",
      source: "APPLE_HEALTH",
      measuredAt: new Date("2026-07-20T10:00:00.000Z"),
      sleepStage: null,
      externalId: "stats:HKQuantityTypeIdentifierStepCount:2026-07-20",
      aggregationProvenance: "HEALTHKIT_STATISTICS",
      aggregationContributorCount: null,
      aggregationSelectedSourceHash: null,
    });
    const { tx, measurement } = transaction([native]);

    const verdict = await reconcileExternalMeasurement(
      tx,
      desired({
        type: "ACTIVITY_STEPS",
        value: 8_526,
        unit: "steps",
        source: "APPLE_HEALTH",
        measuredAt: new Date("2026-07-20T10:00:00.000Z"),
        sleepStage: null,
        externalId: "stats:HKQuantityTypeIdentifierStepCount:2026-07-20",
        aggregationProvenance: "EXPORT_XML_SOURCE_MAX",
        aggregationContributorCount: 2,
        aggregationSelectedSourceHash: "source-hash",
      }),
      { exactExternalMatch: "update" },
    );

    expect(verdict).toMatchObject({
      status: "duplicate",
      row: { id: "native-stats" },
    });
    expect(measurement.update).not.toHaveBeenCalled();
  });

  it("retires a lower-authority external collision without changing the native natural-key row", async () => {
    const xmlExternal = row({
      id: "xml-external",
      type: "ACTIVITY_STEPS",
      value: 8_526,
      unit: "steps",
      source: "APPLE_HEALTH",
      measuredAt: new Date("2026-07-20T09:00:00.000Z"),
      sleepStage: null,
      externalId: "stats:HKQuantityTypeIdentifierStepCount:2026-07-20",
      aggregationProvenance: "EXPORT_XML_SOURCE_MAX",
    });
    const nativeNatural = row({
      id: "native-natural",
      type: "ACTIVITY_STEPS",
      value: 8_600,
      unit: "steps",
      source: "APPLE_HEALTH",
      measuredAt: new Date("2026-07-20T10:00:00.000Z"),
      sleepStage: null,
      externalId: "stats:legacy-native-id",
      externalSourceVersion: "native-v1",
      deviceType: "Apple Watch",
      aggregationProvenance: "HEALTHKIT_STATISTICS",
    });
    const { tx, measurement } = transaction([xmlExternal, nativeNatural]);

    const verdict = await reconcileExternalMeasurement(
      tx,
      desired({
        type: "ACTIVITY_STEPS",
        value: 8_526,
        unit: "steps",
        source: "APPLE_HEALTH",
        measuredAt: new Date("2026-07-20T10:00:00.000Z"),
        sleepStage: null,
        externalId: "stats:HKQuantityTypeIdentifierStepCount:2026-07-20",
        aggregationProvenance: "EXPORT_XML_SOURCE_MAX",
      }),
      { exactExternalMatch: "update" },
    );

    expect(verdict).toMatchObject({
      status: "duplicate",
      row: {
        id: "native-natural",
        aggregationProvenance: "HEALTHKIT_STATISTICS",
      },
      retiredCollisionId: "xml-external",
    });
    expect(measurement.update).toHaveBeenCalledTimes(1);
    expect(measurement.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "xml-external" },
        data: expect.objectContaining({
          measuredAt: new Date(0),
          externalId:
            "retired:xml-external:stats:HKQuantityTypeIdentifierStepCount:2026-07-20",
          deletedAt: expect.any(Date),
          syncVersion: { increment: 1 },
        }),
      }),
    );
  });

  it("allows native statistics to repair a legacy aggregate", async () => {
    const legacy = row({
      id: "legacy-stats",
      type: "ACTIVITY_STEPS",
      value: 15_608,
      unit: "steps",
      source: "APPLE_HEALTH",
      measuredAt: new Date("2026-07-20T10:00:00.000Z"),
      sleepStage: null,
      externalId: "stats:HKQuantityTypeIdentifierStepCount:2026-07-20",
      aggregationProvenance: "LEGACY_UNKNOWN",
    });
    const { tx, measurement } = transaction([legacy]);
    measurement.update.mockResolvedValue(
      row({
        ...legacy,
        value: 8_600,
        aggregationProvenance: "HEALTHKIT_STATISTICS",
      }),
    );

    const verdict = await reconcileExternalMeasurement(
      tx,
      desired({
        type: "ACTIVITY_STEPS",
        value: 8_600,
        unit: "steps",
        source: "APPLE_HEALTH",
        measuredAt: new Date("2026-07-20T10:00:00.000Z"),
        sleepStage: null,
        externalId: "stats:HKQuantityTypeIdentifierStepCount:2026-07-20",
        aggregationProvenance: "HEALTHKIT_STATISTICS",
        aggregationContributorCount: null,
        aggregationSelectedSourceHash: null,
      }),
      { exactExternalMatch: "update" },
    );

    expect(verdict).toMatchObject({
      status: "updated",
      row: { id: "legacy-stats" },
    });
    expect(measurement.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "legacy-stats" },
        data: expect.objectContaining({
          value: 8_600,
          aggregationProvenance: "HEALTHKIT_STATISTICS",
          aggregationContributorCount: null,
          aggregationSelectedSourceHash: null,
          syncVersion: { increment: 1 },
        }),
      }),
    );
  });

  it("rolls back its savepoint and returns failed for a non-benign write error", async () => {
    const existing = row({
      id: "exact-row",
      measuredAt: new Date("2026-07-20T06:30:00.000Z"),
    });
    const { tx, measurement } = transaction([existing]);
    measurement.update.mockRejectedValue(new Error("connection reset"));

    const verdict = await reconcileExternalMeasurement(tx, desired());

    expect(verdict).toEqual({
      status: "failed",
      error: { message: "connection reset" },
    });
    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith(
      "ROLLBACK TO SAVEPOINT measurement_identity_reconcile",
    );
  });
});
