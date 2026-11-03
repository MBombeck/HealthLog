/**
 * Migration 0401 over a ledger that already holds enum-typed rows.
 *
 * `healthkit_type_syncs.type` moves from the `measurement_type` enum to text
 * so the ledger can hold `MEDICATION_DOSE`, and `last_background_at` arrives
 * beside it. The suite has already applied every migration, so this puts the
 * table back into its 0384 shape, seeds rows the way production holds them,
 * applies the 0401 file as shipped, and checks that every row kept its key and
 * its dates, that a row whose latest arrival was a background one starts with
 * that date, that the primary key still refuses a second row for the same
 * (user, type), and that the writer can now record a dose.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import { recordHealthKitTypeArrivals } from "@/lib/integrations/healthkit-type-sync";

const prisma = getPrismaClient();
const USER = "healthkit-type-sync-migration";

const MIGRATION = readFileSync(
  resolve(
    process.cwd(),
    "prisma",
    "migrations",
    "0401_healthkit_type_sync_text_and_background",
    "migration.sql",
  ),
  "utf8",
);

function steps(): string[] {
  return MIGRATION.split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function runMigration(): Promise<void> {
  await prisma.$transaction(async (tx) => {
    for (const step of steps()) await tx.$executeRawUnsafe(step);
  });
}

async function typeColumn(): Promise<{ data_type: string; udt_name: string }> {
  const rows = await prisma.$queryRaw<
    Array<{ data_type: string; udt_name: string }>
  >`
    SELECT data_type, udt_name FROM information_schema.columns
    WHERE table_name = 'healthkit_type_syncs' AND column_name = 'type'
  `;
  return rows[0];
}

const RECEIVED = {
  WEIGHT: "2026-09-01 06:00:00",
  PULSE: "2026-09-02 07:30:00",
  RESPIRATORY_RATE: "2026-09-03 08:45:00",
} as const;

type Row = {
  type: string;
  last_received_at: Date;
  last_trigger: string | null;
  last_new_sample_at: Date | null;
  last_background_at: Date | null;
};

const readRows = () =>
  prisma.$queryRaw<Row[]>`
    SELECT "type", "last_received_at", "last_trigger", "last_new_sample_at",
           "last_background_at"
    FROM "healthkit_type_syncs" WHERE "user_id" = ${USER} ORDER BY "type"
  `;

beforeAll(async () => {
  await truncateAllTables(prisma);
  await prisma.user.create({
    data: { id: USER, username: USER, timezone: "UTC" },
  });
  // Back to the 0384 shape: the enum column, no background date.
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "healthkit_type_syncs" DROP COLUMN "last_background_at"`,
  );
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "healthkit_type_syncs" ALTER COLUMN "type" SET DATA TYPE "measurement_type" USING "type"::"measurement_type"`,
  );
  await prisma.$executeRawUnsafe(`
    INSERT INTO "healthkit_type_syncs"
      ("user_id", "type", "last_received_at", "last_trigger", "last_new_sample_at")
    VALUES
      ('${USER}', 'WEIGHT', '${RECEIVED.WEIGHT}', 'background', '${RECEIVED.WEIGHT}'),
      ('${USER}', 'PULSE', '${RECEIVED.PULSE}', 'foreground', NULL),
      ('${USER}', 'RESPIRATORY_RATE', '${RECEIVED.RESPIRATORY_RATE}', NULL, '${RECEIVED.RESPIRATORY_RATE}')
  `);
});

afterAll(async () => {
  // Leave the table in the shipped shape for the files that run after this one,
  // whatever happened above.
  const column = await typeColumn();
  if (column.udt_name === "measurement_type") await runMigration();
});

// Before the migration, the migration, after it: the cases are its steps,
// in order, under a shuffled run too.
describe(
  "migration 0401 over enum-typed ledger rows",
  { shuffle: false },
  () => {
    it("starts from the enum column", async () => {
      expect((await typeColumn()).udt_name).toBe("measurement_type");
    });

    it("keeps every row, its key and its dates, and seeds the background date", async () => {
      await runMigration();

      expect(await typeColumn()).toEqual({
        data_type: "text",
        udt_name: "text",
      });
      const rows = await readRows();
      expect(rows.map((r) => r.type)).toEqual([
        "PULSE",
        "RESPIRATORY_RATE",
        "WEIGHT",
      ]);
      const byType = Object.fromEntries(rows.map((r) => [r.type, r]));
      for (const [type, at] of Object.entries(RECEIVED)) {
        expect(byType[type].last_received_at.toISOString()).toBe(
          `${at.replace(" ", "T")}.000Z`,
        );
      }
      expect(byType.WEIGHT.last_trigger).toBe("background");
      expect(byType.WEIGHT.last_new_sample_at?.toISOString()).toBe(
        "2026-09-01T06:00:00.000Z",
      );
      expect(byType.PULSE.last_new_sample_at).toBeNull();
      // Only a row whose latest arrival was a background one knows a date.
      expect(byType.WEIGHT.last_background_at?.toISOString()).toBe(
        "2026-09-01T06:00:00.000Z",
      );
      expect(byType.PULSE.last_background_at).toBeNull();
      expect(byType.RESPIRATORY_RATE.last_background_at).toBeNull();
    });

    it("keeps the primary key on (user, type)", async () => {
      const pkey = await prisma.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'healthkit_type_syncs'
        AND indexname = 'healthkit_type_syncs_pkey'
    `;
      expect(pkey[0]?.indexdef).toContain("(user_id, type)");
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "healthkit_type_syncs" ("user_id", "type", "last_received_at") VALUES ('${USER}', 'WEIGHT', now())`,
        ),
      ).rejects.toThrow();
    });

    it("lets the writer upsert a measurement type and record a dose", async () => {
      const at = new Date("2026-10-01T09:00:00.000Z");
      await recordHealthKitTypeArrivals(prisma, {
        userId: USER,
        counts: new Map([
          ["WEIGHT", { accepted: 1, newSamples: 1 }],
          ["MEDICATION_DOSE", { accepted: 2, newSamples: 2 }],
        ]),
        trigger: "foreground",
        at,
      });
      const rows = await prisma.healthKitTypeSync.findMany({
        where: { userId: USER },
        orderBy: { type: "asc" },
      });
      expect(rows.map((r) => r.type)).toEqual([
        "MEDICATION_DOSE",
        "PULSE",
        "RESPIRATORY_RATE",
        "WEIGHT",
      ]);
      const weight = rows.find((r) => r.type === "WEIGHT")!;
      expect(weight.lastReceivedAt.toISOString()).toBe(at.toISOString());
      expect(weight.lastTrigger).toBe("foreground");
      // The foreground arrival leaves the seeded background date standing.
      expect(weight.lastBackgroundAt?.toISOString()).toBe(
        "2026-09-01T06:00:00.000Z",
      );
      const dose = rows.find((r) => r.type === "MEDICATION_DOSE")!;
      expect(dose.lastNewSampleAt?.toISOString()).toBe(at.toISOString());
      expect(dose.lastBackgroundAt).toBeNull();
    });
  },
);
