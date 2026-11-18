import { beforeEach, describe, expect, it } from "vitest";

import {
  reconcileExternalMeasurement,
  reconcileExternalMeasurements,
  type ExternalMeasurementWrite,
  type MeasurementReconciliationVerdict,
} from "@/lib/measurements/reconcile-external-measurement";
import { countStatements } from "./query-counter";
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

describe("batch reconciliation gives the per-reading verdicts", () => {
  const at = (minute: number) =>
    new Date(Date.parse("2026-07-21T06:00:00.000Z") + minute * 60_000);

  /** Every case the reconciler distinguishes, as rows already stored. */
  async function seed(userId: string) {
    const prisma = getPrismaClient();
    const row = (externalId: string, minute: number, extra = {}) =>
      prisma.measurement.create({
        data: {
          ...desired(userId, externalId),
          measuredAt: at(minute),
          value: 30,
          ...extra,
        },
      });
    await row("x:exact", 0);
    await row("x:tomb", 1, { deletedAt: at(-60) });
    await row("x:moved", 2);
    await row("x:legacy", 4);
    await row("x:both", 5);
    await row("x:occupant", 6);
    await row("x:quiet", 20);
    await row("x:native", 30, {
      aggregationProvenance: "HEALTHKIT_STATISTICS",
    });
    await row("x:estimate", 31, {
      aggregationProvenance: "EXPORT_XML_SOURCE_MAX",
    });
  }

  /** The batch: written against the seeded rows, in this order. */
  function batch(userId: string): ExternalMeasurementWrite[] {
    const entry = (externalId: string, minute: number, extra = {}) =>
      desired(userId, externalId, { measuredAt: at(minute), ...extra });
    return [
      entry("x:fresh-1", 10),
      entry("x:exact", 0),
      entry("x:tomb", 1),
      entry("x:moved", 3),
      entry("x:natural", 4),
      entry("x:both", 6),
      entry("x:dup", 11),
      entry("x:fresh-2", 12, { sleepStage: "REM" }),
      entry("x:dup", 13, { value: 44 }),
      entry("x:refused", 14, { value: 5_000 }),
      entry("x:shared-natural", 15),
      entry("x:shared-natural-twin", 15),
      entry("x:quiet", 20),
      // A weaker aggregate than the stored one changes nothing; a stronger
      // one overwrites it.
      entry("x:native", 30, { aggregationProvenance: "EXPORT_XML_SOURCE_MAX" }),
      entry("x:estimate", 31, {
        aggregationProvenance: "HEALTHKIT_STATISTICS",
      }),
    ];
  }

  function shape(verdict: MeasurementReconciliationVerdict) {
    if (verdict.status === "failed" || verdict.status === "rejected_range") {
      return { status: verdict.status };
    }
    return {
      status: verdict.status,
      externalId: verdict.row.externalId,
      measuredAt: verdict.row.measuredAt,
      retired: verdict.retiredCollisionId !== undefined,
      dirty: (verdict.dirtyIdentities ?? []).map((d) => d.measuredAt),
    };
  }

  async function stored(userId: string) {
    const rows = await getPrismaClient().measurement.findMany({
      where: { userId },
    });
    return rows
      .map((r) => ({
        externalId: r.externalId?.replace(/^retired:[^:]+:/, "retired:"),
        measuredAt: r.measuredAt,
        value: r.value,
        sleepStage: r.sleepStage,
        aggregationProvenance: r.aggregationProvenance,
        deleted: r.deletedAt !== null,
        syncVersion: r.syncVersion,
      }))
      .sort((a, b) =>
        `${a.externalId}|${a.measuredAt.getTime()}`.localeCompare(
          `${b.externalId}|${b.measuredAt.getTime()}`,
        ),
      );
  }

  it.each(["update", "duplicate"] as const)(
    "matches the reconciler entry by entry (exact match: %s)",
    async (exactExternalMatch) => {
      const prisma = getPrismaClient();
      const one = await createUser(`batch-one-${exactExternalMatch}`);
      const set = await createUser(`batch-set-${exactExternalMatch}`);
      await seed(one.id);
      await seed(set.id);
      // Another account holding the same external id is never touched.
      const other = await createUser(`batch-other-${exactExternalMatch}`);
      await prisma.measurement.create({
        data: desired(other.id, "x:fresh-1", { measuredAt: at(10) }),
      });

      const sequential = await countStatements(() =>
        prisma.$transaction(async (tx) => {
          const out: MeasurementReconciliationVerdict[] = [];
          for (const entry of batch(one.id)) {
            out.push(
              await reconcileExternalMeasurement(tx, entry, {
                exactExternalMatch,
              }),
            );
          }
          return out;
        }),
      );
      const together = await countStatements(() =>
        prisma.$transaction((tx) =>
          reconcileExternalMeasurements(tx, batch(set.id), {
            exactExternalMatch,
          }),
        ),
      );

      expect(together.result.map(shape)).toEqual(sequential.result.map(shape));
      // Every status the reconciler can give a stored row is in the batch.
      expect(new Set(sequential.result.map((v) => v.status))).toEqual(
        new Set([
          "inserted",
          "updated",
          "rejected_range",
          "duplicate",
          ...(exactExternalMatch === "update" ? ["resurrected"] : []),
        ]),
      );
      expect(together.count).toBeLessThan(sequential.count);
      expect(await stored(set.id)).toEqual(await stored(one.id));
      expect(
        await prisma.measurement.count({ where: { userId: other.id } }),
      ).toBe(1);
    },
  );

  it("settles readings that share no identity in sets, first written and re-read", async () => {
    const prisma = getPrismaClient();
    const user = await createUser("batch-statements");
    const readings = Array.from({ length: 200 }, (_, i) =>
      desired(user.id, `x:day-${i}`, { measuredAt: at(i * 1_440) }),
    );
    const write = () =>
      countStatements(() =>
        prisma.$transaction((tx) =>
          reconcileExternalMeasurements(tx, readings, {
            exactExternalMatch: "update",
          }),
        ),
      );

    // Reading by reading this was about eight statements each, and every
    // candidate read walked the account's rows when the planner did not know
    // the account yet.
    const first = await write();
    expect(first.result.every((v) => v.status === "inserted")).toBe(true);
    expect(first.count).toBeLessThanOrEqual(10);

    // A re-read is one read for the batch and the reconciler's overwrite
    // per reading.
    const again = await write();
    expect(again.result.every((v) => v.status === "updated")).toBe(true);
    expect(again.count).toBeLessThanOrEqual(readings.length + 10);
    expect(await prisma.measurement.count({ where: { userId: user.id } })).toBe(
      readings.length,
    );
  });
});
