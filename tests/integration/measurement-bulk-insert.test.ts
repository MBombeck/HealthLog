/**
 * `insertMeasurementRows` replaced `createMany` in the restore because
 * Prisma's cached plan for a 1 000-row `createMany` kept about 145 MB alive
 * (#1031). It writes raw SQL, so this pins that a row written through it
 * reads back exactly as the same row written through Prisma, every column
 * set, and every column null where it may be.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import {
  insertMeasurementRows,
  insertNewMeasurementRows,
  newMeasurementId,
  type MeasurementInsertRow,
  type NewMeasurementRow,
} from "@/lib/export/measurement-bulk-insert";

const USER = "user-bulk-insert";

beforeEach(async () => {
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  await prisma.user.create({
    data: { id: USER, username: USER, email: `${USER}@example.test` },
  });
});

function full(id: string, at: string): MeasurementInsertRow {
  return {
    id,
    userId: USER,
    type: "SLEEP_DURATION",
    value: 47.25,
    valueMin: 1.5,
    valueMax: 99.75,
    unit: "minutes",
    source: "APPLE_HEALTH",
    measuredAt: new Date(at),
    notes: "legacy note",
    notesEncrypted: new Uint8Array([0, 1, 2, 254, 255]),
    externalId: `ext-${id}`,
    externalSourceVersion: "17.4",
    aggregationProvenance: "HEALTHKIT_STATISTICS",
    glucoseContext: null,
    sleepStage: "REM",
    rhythmClassification: null,
    deviceType: "watch",
    syncVersion: 7,
    deletedAt: new Date("2026-02-03T04:05:06.789Z"),
    createdAt: new Date("2025-01-02T03:04:05.678Z"),
    updatedAt: new Date("2025-06-07T08:09:10.111Z"),
  };
}

function sparse(id: string, at: string): MeasurementInsertRow {
  return {
    id,
    userId: USER,
    type: "BLOOD_GLUCOSE",
    value: 5.4,
    valueMin: null,
    valueMax: null,
    unit: "mmol/L",
    source: "MANUAL",
    measuredAt: new Date(at),
    notes: null,
    notesEncrypted: null,
    externalId: null,
    externalSourceVersion: null,
    aggregationProvenance: null,
    glucoseContext: "FASTING",
    sleepStage: null,
    rhythmClassification: null,
    deviceType: null,
    syncVersion: 1,
    deletedAt: null,
  };
}

describe("insertMeasurementRows", () => {
  it("writes every column exactly as Prisma create does", async () => {
    const prisma = getPrismaClient();
    const rows = [
      [
        full("a-bulk", "2026-01-01T10:00:00.123Z"),
        full("a-prisma", "2026-01-02T10:00:00.123Z"),
      ],
      [
        sparse("b-bulk", "2026-01-03T10:00:00.000Z"),
        sparse("b-prisma", "2026-01-04T10:00:00.000Z"),
      ],
    ] as const;

    for (const [viaBulk, viaPrisma] of rows) {
      await prisma.$transaction((tx) => insertMeasurementRows(tx, [viaBulk]));
      await prisma.measurement.create({ data: viaPrisma as never });
    }

    for (const [viaBulk, viaPrisma] of rows) {
      const a = await prisma.measurement.findUniqueOrThrow({
        where: { id: viaBulk.id },
      });
      const b = await prisma.measurement.findUniqueOrThrow({
        where: { id: viaPrisma.id },
      });
      const strip = (row: typeof a) => ({
        ...row,
        id: undefined,
        externalId: row.externalId?.replace(/-(bulk|prisma)$/, ""),
        measuredAt: undefined,
        // Filled with the current time when the row carries none.
        ...(viaBulk.createdAt
          ? {}
          : { createdAt: undefined, updatedAt: undefined }),
      });
      expect(strip(a)).toEqual(strip(b));
      expect(a.measuredAt.toISOString()).toBe(viaBulk.measuredAt.toISOString());
    }
    const sparseRow = await prisma.measurement.findUniqueOrThrow({
      where: { id: "b-bulk" },
    });
    expect(Date.now() - sparseRow.createdAt.getTime()).toBeLessThan(60_000);
  });

  it("inserts a whole batch in one statement and reports the count", async () => {
    const prisma = getPrismaClient();
    const batch = Array.from({ length: 2_500 }, (_, i) =>
      sparse(
        `m-${i}`,
        new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
      ),
    );
    const inserted = await prisma.$transaction((tx) =>
      insertMeasurementRows(tx, batch),
    );
    expect(inserted).toBe(2_500);
    expect(await prisma.measurement.count({ where: { userId: USER } })).toBe(
      2_500,
    );
  });
});

/**
 * `insertNewMeasurementRows` replaced `createManyAndReturn({ skipDuplicates })`
 * in the Apple Health export import. Each case below runs the same input
 * through both and compares what they return and what they leave in the
 * table, so a difference in either direction fails.
 */
describe("insertNewMeasurementRows", () => {
  function spot(
    externalId: string,
    at: string,
    overrides: Partial<NewMeasurementRow> = {},
  ): NewMeasurementRow {
    return {
      userId: USER,
      type: "PULSE",
      value: 61,
      unit: "bpm",
      source: "APPLE_HEALTH",
      measuredAt: new Date(at),
      externalId,
      externalSourceVersion: "17.4",
      sleepStage: null,
      deviceType: null,
      ...overrides,
    };
  }

  const SELECT = {
    id: true,
    type: true,
    measuredAt: true,
    externalId: true,
  } as const;

  /** Run `rows` through Prisma, then through the raw path in a fresh table. */
  async function both(seed: NewMeasurementRow[], rows: NewMeasurementRow[]) {
    const prisma = getPrismaClient();
    const run = async (
      write: (r: NewMeasurementRow[]) => Promise<
        Array<{
          id: string;
          type: string;
          measuredAt: Date;
          externalId: string | null;
        }>
      >,
    ) => {
      await prisma.measurement.deleteMany({ where: { userId: USER } });
      if (seed.length > 0) {
        await prisma.measurement.createMany({ data: seed as never });
      }
      const returned = await write(rows);
      const table = await prisma.measurement.findMany({
        where: { userId: USER },
        orderBy: [{ measuredAt: "asc" }, { externalId: "asc" }],
      });
      return {
        returned: returned
          .map(({ id: _id, ...rest }) => rest)
          .sort((a, b) => `${a.externalId}`.localeCompare(`${b.externalId}`)),
        table: table.map(
          ({ id: _id, createdAt: _c, updatedAt: _u, ...rest }) => rest,
        ),
        ids: returned.map((r) => r.id),
      };
    };
    const viaPrisma = await run((r) =>
      prisma.measurement.createManyAndReturn({
        data: r as never,
        skipDuplicates: true,
        select: SELECT,
      }),
    );
    const viaRaw = await run((r) => insertNewMeasurementRows(prisma, r));
    return { viaPrisma, viaRaw };
  }

  it("returns and stores exactly what createManyAndReturn does", async () => {
    const rows = [
      spot("hr-1", "2026-03-01T08:00:00.123Z"),
      spot("sleep-1", "2026-03-01T06:00:00.000Z", {
        type: "SLEEP_DURATION",
        value: 42.5,
        unit: "minutes",
        sleepStage: "REM",
        deviceType: "watch",
      }),
      spot("spo2-1", "2026-03-01T09:00:00.000Z", {
        type: "OXYGEN_SATURATION",
        value: 97,
        unit: "%",
        externalSourceVersion: null,
      }),
    ];
    const { viaPrisma, viaRaw } = await both([], rows);
    expect(viaRaw.returned).toEqual(viaPrisma.returned);
    expect(viaRaw.table).toEqual(viaPrisma.table);
    expect(viaRaw.returned).toHaveLength(3);
    for (const r of viaRaw.returned) expect(r.measuredAt).toBeInstanceOf(Date);
  });

  it("skips a row that meets an existing row on either unique identity", async () => {
    const seed = [
      // Same external id as `ext-dup`.
      spot("ext-dup", "2026-03-02T08:00:00.000Z", { value: 70 }),
      // Same (type, measured_at, source, sleep_stage) as `nat-dup`.
      spot("seeded-natural", "2026-03-02T09:00:00.000Z", { value: 71 }),
    ];
    const rows = [
      spot("ext-dup", "2026-03-02T10:00:00.000Z", { value: 80 }),
      spot("nat-dup", "2026-03-02T09:00:00.000Z", { value: 81 }),
      spot("fresh", "2026-03-02T11:00:00.000Z", { value: 82 }),
    ];
    const { viaPrisma, viaRaw } = await both(seed, rows);
    expect(viaRaw.returned).toEqual(viaPrisma.returned);
    expect(viaRaw.table).toEqual(viaPrisma.table);
    expect(viaRaw.returned.map((r) => r.externalId)).toEqual(["fresh"]);
  });

  it("keeps the first of two rows in one call that share an identity", async () => {
    const rows = [
      spot("twin", "2026-03-03T08:00:00.000Z", { value: 90 }),
      spot("twin", "2026-03-03T08:30:00.000Z", { value: 91 }),
      spot("other", "2026-03-03T08:00:00.000Z", { value: 92 }),
    ];
    const { viaPrisma, viaRaw } = await both([], rows);
    expect(viaRaw.returned).toEqual(viaPrisma.returned);
    expect(viaRaw.table).toEqual(viaPrisma.table);
    expect(viaRaw.returned).toHaveLength(1);
  });

  it("mints ids in the shape the cuid() default produces", async () => {
    const prisma = getPrismaClient();
    await prisma.measurement.deleteMany({ where: { userId: USER } });
    const viaPrisma = await prisma.measurement.create({
      data: spot("shape-prisma", "2026-03-04T08:00:00.000Z") as never,
    });
    const [viaRaw] = await insertNewMeasurementRows(prisma, [
      spot("shape-raw", "2026-03-04T09:00:00.000Z"),
    ]);
    const shape = /^c[0-9a-z]{24}$/;
    expect(viaPrisma.id).toMatch(shape);
    expect(viaRaw!.id).toMatch(shape);
    const ids = new Set(Array.from({ length: 10_000 }, newMeasurementId));
    expect(ids.size).toBe(10_000);
    const stored = await prisma.measurement.findUniqueOrThrow({
      where: { id: viaRaw!.id },
    });
    expect(stored.syncVersion).toBe(1);
    expect(stored.deletedAt).toBeNull();
    expect(Math.abs(Date.now() - stored.createdAt.getTime())).toBeLessThan(
      60_000,
    );
    expect(stored.updatedAt.getTime()).toBe(stored.createdAt.getTime());
  });

  it("answers an empty call without touching the database", async () => {
    expect(await insertNewMeasurementRows(getPrismaClient(), [])).toEqual([]);
  });
});
