/**
 * Re-importing an Apple Health export the account already holds, against a
 * real Postgres.
 *
 * Every row the insert skips used to cost one UPDATE writing back what was
 * stored. A row whose stored values already equal what the update would
 * write is now left out: the per-type counts are the same as before (each
 * such row counts as updated), the stored rows are the same, and the import
 * sends no UPDATE for them. A row whose value changed is still updated, and
 * a key the chunk carries twice is still written in order.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { beforeEach, describe, expect, it } from "vitest";

import { streamParseExportXml } from "@/lib/measurements/import-apple-health-export";

import { makeUser } from "../kit/factories";
import { countStatements, summariseStatements } from "./query-counter";
import { getPrismaClient, truncateAllTables } from "./setup";

const prisma = getPrismaClient();

function writeXml(records: string): string {
  const dir = mkdtempSync(join(tmpdir(), "healthlog-reimport-"));
  const path = join(dir, "export.xml");
  writeFileSync(
    path,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE HealthData [<!ELEMENT HealthData (Record)*>]>
<HealthData locale="en_US">
${records}
</HealthData>`,
  );
  return path;
}

function weights(values: number[]): string {
  return values
    .map(
      (value, day) => `  <Record type="HKQuantityTypeIdentifierBodyMass"
          unit="kg" sourceName="Scale"
          startDate="2026-05-${String(day + 1).padStart(2, "0")} 08:00:00 +0200"
          endDate="2026-05-${String(day + 1).padStart(2, "0")} 08:00:00 +0200"
          value="${value}"/>`,
    )
    .join("\n");
}

async function stored(userId: string) {
  return prisma.measurement.findMany({
    where: { userId, type: "WEIGHT" },
    orderBy: { measuredAt: "asc" },
    select: { value: true, measuredAt: true, externalId: true },
  });
}

describe("Apple Health re-import of unchanged rows", () => {
  let userId: string;
  const values = Array.from({ length: 20 }, (_, i) => 70 + i / 10);

  beforeEach(async () => {
    await truncateAllTables(prisma);
    userId = (await makeUser()).id;
    const first = await streamParseExportXml({
      xmlPath: writeXml(weights(values)),
      userId,
      userTimezone: "Europe/Berlin",
      prisma,
    });
    expect(first.perType.WEIGHT?.inserted).toBe(values.length);
  });

  it("counts every row as updated, as before, and sends no UPDATE", async () => {
    const before = await stored(userId);
    const measured = await countStatements(() =>
      streamParseExportXml({
        xmlPath: writeXml(weights(values)),
        userId,
        userTimezone: "Europe/Berlin",
        prisma,
      }),
    );
    expect(measured.result.perType.WEIGHT?.inserted).toBe(0);
    expect(measured.result.perType.WEIGHT?.updated).toBe(values.length);
    expect(await stored(userId)).toEqual(before);
    const updates = measured.statements.filter((sql) =>
      /^\s*UPDATE "public"\."measurements"/i.test(sql),
    );
    expect(updates).toEqual([]);
  });

  it("still updates a row whose value changed", async () => {
    const changed = [...values];
    changed[3] = 99.9;
    const result = await streamParseExportXml({
      xmlPath: writeXml(weights(changed)),
      userId,
      userTimezone: "Europe/Berlin",
      prisma,
    });
    expect(result.perType.WEIGHT?.updated).toBe(values.length);
    const rows = await stored(userId);
    // The externalId hashes the sample, so a new value is a new sample of
    // the same instant: it adopts the stored row through the natural key.
    expect(rows).toHaveLength(values.length);
    expect(rows[3]!.value).toBe(99.9);
  });
});

describe("Apple Health daily step totals", () => {
  const DAYS = 200;

  function steps(perDay: number): string {
    return Array.from({ length: DAYS }, (_, day) => {
      const date = new Date(Date.UTC(2025, 0, 1) + day * 86_400_000)
        .toISOString()
        .slice(0, 10);
      return `  <Record type="HKQuantityTypeIdentifierStepCount"
          unit="count" sourceName="Phone"
          startDate="${date} 09:00:00 +0000" endDate="${date} 09:30:00 +0000"
          value="${perDay}"/>`;
    }).join("\n");
  }

  it("writes and re-writes a day's total in sets, not one transaction a day", async () => {
    await truncateAllTables(prisma);
    const userId = (await makeUser()).id;
    const run = (perDay: number) =>
      countStatements(() =>
        streamParseExportXml({
          xmlPath: writeXml(steps(perDay)),
          userId,
          userTimezone: "UTC",
          prisma,
        }),
      );

    // One day at a time this was a transaction of about ten statements a day.
    const first = await run(4_000);
    expect(first.result.perType.ACTIVITY_STEPS?.inserted).toBe(DAYS);
    expect(
      first.count,
      summariseStatements(first.statements).slice(0, 2_000),
    ).toBeLessThanOrEqual(DAYS / 2);

    const again = await run(5_000);
    expect(again.result.perType.ACTIVITY_STEPS?.updated).toBe(DAYS);
    expect(
      await prisma.measurement.count({
        where: { userId, type: "ACTIVITY_STEPS", value: 5_000 },
      }),
    ).toBe(DAYS);
    expect(
      again.count,
      summariseStatements(again.statements).slice(0, 2_000),
    ).toBeLessThanOrEqual(DAYS * 1.5);
  });
});
