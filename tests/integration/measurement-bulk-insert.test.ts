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
  type MeasurementInsertRow,
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
