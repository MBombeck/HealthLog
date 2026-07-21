import { beforeEach, describe, expect, it } from "vitest";

import {
  reconcileExternalMeasurement,
  type ExternalMeasurementWrite,
} from "@/lib/measurements/reconcile-external-measurement";
import { getPrismaClient, truncateAllTables } from "./setup";

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
});

async function createUser(id: string) {
  return getPrismaClient().user.create({
    data: {
      id,
      username: id,
      email: `${id}@example.test`,
      role: "USER",
    },
  });
}

const measuredAt = new Date("2026-07-20T06:30:00.000Z");

function desired(
  userId: string,
  externalId: string,
  overrides: Partial<ExternalMeasurementWrite> = {},
): ExternalMeasurementWrite {
  return {
    userId,
    type: "SLEEP_DURATION" as const,
    value: 42,
    unit: "minutes",
    source: "OURA" as const,
    measuredAt,
    sleepStage: "DEEP" as const,
    externalId,
    externalSourceVersion: "v2",
    deviceType: "ring",
    ...overrides,
  };
}

async function reconcile(
  input: ExternalMeasurementWrite,
  options?: { exactExternalMatch?: "update" | "duplicate" },
) {
  const prisma = getPrismaClient();
  return prisma.$transaction((tx) =>
    reconcileExternalMeasurement(tx, input, options),
  );
}

describe("external measurement identity reconciliation (real Postgres)", () => {
  it("moves an external-id hit onto an occupied natural key and retires the redundant row", async () => {
    const prisma = getPrismaClient();
    const user = await createUser("identity-external-move");
    const external = await prisma.measurement.create({
      data: {
        ...desired(user.id, "sleep:new"),
        value: 30,
        measuredAt: new Date("2026-07-20T06:00:00.000Z"),
        externalSourceVersion: null,
      },
    });
    const collision = await prisma.measurement.create({
      data: {
        ...desired(user.id, "sleep:legacy"),
        value: 35,
      },
    });

    const verdict = await reconcile(desired(user.id, "sleep:new"));

    expect(verdict).toMatchObject({
      status: "updated",
      row: { id: external.id, externalId: "sleep:new" },
      retiredCollisionId: collision.id,
    });
    const rows = await prisma.measurement.findMany({
      where: { userId: user.id },
    });
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === external.id)).toMatchObject({
      value: 42,
      measuredAt,
      externalId: "sleep:new",
      externalSourceVersion: "v2",
      deviceType: "ring",
      deletedAt: null,
    });
    expect(rows.find((row) => row.id === collision.id)).toMatchObject({
      externalId: "sleep:legacy",
      deletedAt: expect.any(Date),
    });
  });

  it("retires a lower-authority XML collision while preserving the native aggregate", async () => {
    const prisma = getPrismaClient();
    const user = await createUser("identity-native-authority");
    const nativeMeasuredAt = new Date("2026-07-20T10:00:00.000Z");
    const xmlExternal = await prisma.measurement.create({
      data: {
        ...desired(
          user.id,
          "stats:HKQuantityTypeIdentifierStepCount:2026-07-20",
          {
            type: "ACTIVITY_STEPS",
            value: 8_526,
            unit: "steps",
            source: "APPLE_HEALTH",
            measuredAt: new Date("2026-07-20T09:00:00.000Z"),
            sleepStage: null,
            aggregationProvenance: "EXPORT_XML_SOURCE_MAX",
            aggregationContributorCount: 2,
            aggregationSelectedSourceHash: "xml-source-hash",
          },
        ),
      },
    });
    const native = await prisma.measurement.create({
      data: {
        ...desired(user.id, "stats:legacy-native-id", {
          type: "ACTIVITY_STEPS",
          value: 8_600,
          unit: "steps",
          source: "APPLE_HEALTH",
          measuredAt: nativeMeasuredAt,
          sleepStage: null,
          externalSourceVersion: "native-v1",
          deviceType: "Apple Watch",
          aggregationProvenance: "HEALTHKIT_STATISTICS",
          aggregationContributorCount: null,
          aggregationSelectedSourceHash: null,
        }),
      },
    });

    const verdict = await reconcile(
      desired(user.id, "stats:HKQuantityTypeIdentifierStepCount:2026-07-20", {
        type: "ACTIVITY_STEPS",
        value: 8_526,
        unit: "steps",
        source: "APPLE_HEALTH",
        measuredAt: nativeMeasuredAt,
        sleepStage: null,
        aggregationProvenance: "EXPORT_XML_SOURCE_MAX",
        aggregationContributorCount: 2,
        aggregationSelectedSourceHash: "xml-source-hash",
      }),
      { exactExternalMatch: "update" },
    );

    expect(verdict).toMatchObject({
      status: "duplicate",
      row: { id: native.id, externalId: "stats:legacy-native-id" },
      retiredCollisionId: xmlExternal.id,
    });
    const liveRows = await prisma.measurement.findMany({
      where: { userId: user.id, deletedAt: null },
    });
    expect(liveRows).toHaveLength(1);
    expect(liveRows[0]).toMatchObject({
      id: native.id,
      value: 8_600,
      unit: "steps",
      measuredAt: nativeMeasuredAt,
      externalId: "stats:legacy-native-id",
      externalSourceVersion: "native-v1",
      deviceType: "Apple Watch",
      aggregationProvenance: "HEALTHKIT_STATISTICS",
      aggregationContributorCount: null,
      aggregationSelectedSourceHash: null,
    });
    expect(
      await prisma.measurement.findUniqueOrThrow({
        where: { id: xmlExternal.id },
      }),
    ).toMatchObject({
      externalId: `retired:${xmlExternal.id}:stats:HKQuantityTypeIdentifierStepCount:2026-07-20`,
      deletedAt: expect.any(Date),
    });

    const nativeUpdate = await reconcile(
      desired(user.id, "stats:HKQuantityTypeIdentifierStepCount:2026-07-20", {
        type: "ACTIVITY_STEPS",
        value: 8_700,
        unit: "steps",
        source: "APPLE_HEALTH",
        measuredAt: nativeMeasuredAt,
        sleepStage: null,
        externalSourceVersion: "native-v2",
        deviceType: "Apple Watch",
        aggregationProvenance: "HEALTHKIT_STATISTICS",
        aggregationContributorCount: null,
        aggregationSelectedSourceHash: null,
      }),
      { exactExternalMatch: "update" },
    );

    expect(nativeUpdate).toMatchObject({
      status: "updated",
      row: {
        id: native.id,
        externalId: "stats:HKQuantityTypeIdentifierStepCount:2026-07-20",
      },
    });
    expect(
      await prisma.measurement.findMany({
        where: { userId: user.id, deletedAt: null },
      }),
    ).toEqual([
      expect.objectContaining({
        id: native.id,
        value: 8_700,
        externalSourceVersion: "native-v2",
        aggregationProvenance: "HEALTHKIT_STATISTICS",
      }),
    ]);
  });

  it("adopts a live natural-key row when a new external id collides", async () => {
    const prisma = getPrismaClient();
    const user = await createUser("identity-natural-live");
    const occupied = await prisma.measurement.create({
      data: { ...desired(user.id, "sleep:legacy"), value: 30 },
    });

    const verdict = await reconcile(desired(user.id, "sleep:new"));

    expect(verdict).toMatchObject({
      status: "updated",
      row: { id: occupied.id, externalId: "sleep:new" },
    });
    expect(await prisma.measurement.count({ where: { userId: user.id } })).toBe(
      1,
    );
  });

  it("resurrects and re-keys a tombstone occupying the natural key", async () => {
    const prisma = getPrismaClient();
    const user = await createUser("identity-natural-tombstone");
    const occupied = await prisma.measurement.create({
      data: {
        ...desired(user.id, "sleep:legacy"),
        value: 30,
        deletedAt: new Date("2026-07-20T08:00:00.000Z"),
      },
    });

    const verdict = await reconcile(desired(user.id, "sleep:new"));

    expect(verdict).toMatchObject({
      status: "resurrected",
      row: { id: occupied.id, externalId: "sleep:new" },
    });
    const stored = await prisma.measurement.findUniqueOrThrow({
      where: { id: occupied.id },
    });
    expect(stored.deletedAt).toBeNull();
    expect(stored.value).toBe(42);
  });

  it("never merges a row owned by another user", async () => {
    const prisma = getPrismaClient();
    const first = await createUser("identity-owner-first");
    const second = await createUser("identity-owner-second");
    const other = await prisma.measurement.create({
      data: desired(first.id, "sleep:shared"),
    });

    const verdict = await reconcile(desired(second.id, "sleep:shared"));

    expect(verdict.status).toBe("inserted");
    expect(await prisma.measurement.count()).toBe(2);
    expect(
      await prisma.measurement.findUniqueOrThrow({ where: { id: other.id } }),
    ).toMatchObject({ userId: first.id, value: 42 });
  });

  it("serializes concurrent attempts that share the same natural identity", async () => {
    const prisma = getPrismaClient();
    const user = await createUser("identity-concurrent");

    const verdicts = await Promise.all([
      reconcile(desired(user.id, "sleep:race-a", { value: 41 })),
      reconcile(desired(user.id, "sleep:race-b", { value: 43 })),
    ]);

    expect(verdicts.every((verdict) => verdict.status !== "failed")).toBe(true);
    expect(verdicts.map((verdict) => verdict.status).sort()).toEqual([
      "inserted",
      "updated",
    ]);
    const rows = await prisma.measurement.findMany({
      where: { userId: user.id },
    });
    expect(rows).toHaveLength(1);
    expect(["sleep:race-a", "sleep:race-b"]).toContain(rows[0]?.externalId);
    expect([41, 43]).toContain(rows[0]?.value);
  });

  it("serializes crossing external and natural identity moves", async () => {
    const prisma = getPrismaClient();
    const user = await createUser("identity-crossing-race");
    const firstTime = new Date("2026-07-20T06:00:00.000Z");
    const secondTime = new Date("2026-07-20T07:00:00.000Z");
    await prisma.measurement.create({
      data: desired(user.id, "sleep:race-a", { measuredAt: firstTime }),
    });

    const verdicts = await Promise.all([
      reconcile(
        desired(user.id, "sleep:race-a", {
          measuredAt: secondTime,
          value: 41,
        }),
      ),
      reconcile(
        desired(user.id, "sleep:race-b", {
          measuredAt: firstTime,
          value: 43,
        }),
      ),
    ]);

    expect(verdicts.every((verdict) => verdict.status !== "failed")).toBe(true);
    const rows = await prisma.measurement.findMany({
      where: { userId: user.id, deletedAt: null },
      orderBy: { measuredAt: "asc" },
    });
    expect(rows).toHaveLength(2);
    expect(rows).toEqual([
      expect.objectContaining({
        externalId: "sleep:race-b",
        measuredAt: firstTime,
        value: 43,
      }),
      expect.objectContaining({
        externalId: "sleep:race-a",
        measuredAt: secondTime,
        value: 41,
      }),
    ]);
  });
});
