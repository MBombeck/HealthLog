/**
 * Integration suite for the v1.15.0 cycle import-promotion (wave 4) and the
 * cycle export inclusion (wave 9) against a real Postgres testcontainer.
 *
 *   - the Apple Health `export.xml` importer routes reproductive HK samples
 *     into CYCLE day-logs (NOT Measurement), gated on cycle-tracking enabled,
 *     merging same-day samples into one row with first-write-wins re-import
 *   - the full-backup cycle section round-trips through
 *     `buildCycleBackupSection` → `restoreCycleData` with the note carried
 *     readable, re-sealed on restore, and symptom links re-resolved by key
 */
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import { streamParseExportXml } from "@/lib/measurements/import-apple-health-export";
import { buildCycleBackupSection, restoreCycleData } from "@/lib/cycle/backup";
import { decrypt, encrypt } from "@/lib/crypto";
import type { RestoreSkipLog } from "@/lib/export/restore-skips";
import { parseBackupPayload } from "@/lib/validations/backup";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const USER_ID = "user-cycle-import";

beforeEach(async () => {
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  await prisma.user.create({
    data: {
      id: USER_ID,
      username: "cycle-import",
      email: "cycle-import@example.test",
      gender: "FEMALE",
      timezone: "Europe/Berlin",
    },
  });
  // Ensure a catalogue symptom exists for the link re-resolution (the
  // TRUNCATE CASCADE may wipe the migration-seeded catalogue).
  await prisma.cycleSymptomCategory.upsert({
    where: { key: "physical" },
    update: {},
    create: { key: "physical", labelKey: "cycle.symptomCategory.physical" },
  });
  const category = await prisma.cycleSymptomCategory.findUniqueOrThrow({
    where: { key: "physical" },
  });
  await prisma.cycleSymptom.upsert({
    where: { key: "cramps" },
    update: {},
    create: {
      key: "cramps",
      labelKey: "cycle.symptom.cramps",
      categoryId: category.id,
    },
  });
});

function writeXml(records: string): string {
  const dir = mkdtempSync(join(tmpdir(), "hl-cycle-xml-"));
  const path = join(dir, "export.xml");
  writeFileSync(
    path,
    `<?xml version="1.0" encoding="UTF-8"?>\n<HealthData>\n${records}\n</HealthData>`,
  );
  return path;
}

describe("cycle import — reproductive HK samples route to CycleDayLog", () => {
  it("folds same-day flow + mucus + cramps into one day-log, not Measurement", async () => {
    const prisma = getPrismaClient();
    const xml = writeXml(
      [
        `<Record type="HKCategoryTypeIdentifierMenstrualFlow" value="HKCategoryValueMenstrualFlowMedium" startDate="2026-03-02 08:00:00 +0000" endDate="2026-03-02 08:00:00 +0000"/>`,
        `<Record type="HKCategoryTypeIdentifierCervicalMucusQuality" value="HKCategoryValueCervicalMucusQualityEggWhite" startDate="2026-03-02 09:00:00 +0000" endDate="2026-03-02 09:00:00 +0000"/>`,
        `<Record type="HKCategoryTypeIdentifierAbdominalCramps" value="3" startDate="2026-03-02 10:00:00 +0000" endDate="2026-03-02 10:00:00 +0000"/>`,
      ].join("\n"),
    );

    const result = await streamParseExportXml({
      xmlPath: xml,
      userId: USER_ID,
      userTimezone: "Europe/Berlin",
      prisma,
    });

    expect(result.cycle.samplesConsumed).toBe(3);
    expect(result.cycle.daysUpserted).toBe(1);
    expect(result.cycle.daysInserted).toBe(1);

    const dayLogs = await prisma.cycleDayLog.findMany({
      where: { userId: USER_ID },
      include: { symptomLinks: { include: { symptom: true } } },
    });
    expect(dayLogs).toHaveLength(1);
    expect(dayLogs[0].date).toBe("2026-03-02");
    expect(dayLogs[0].flow).toBe("MEDIUM");
    expect(dayLogs[0].cervicalMucus).toBe("EGG_WHITE");
    expect(dayLogs[0].source).toBe("APPLE_HEALTH");
    expect(dayLogs[0].symptomLinks.map((l) => l.symptom.key)).toContain(
      "cramps",
    );

    // No reproductive Measurement rows were created.
    const measurements = await prisma.measurement.count({
      where: { userId: USER_ID },
    });
    expect(measurements).toBe(0);
  });

  it("is idempotent on re-import (first-write-wins on the synthetic day key)", async () => {
    const prisma = getPrismaClient();
    const records = `<Record type="HKCategoryTypeIdentifierMenstrualFlow" value="HKCategoryValueMenstrualFlowHeavy" startDate="2026-03-05 08:00:00 +0000" endDate="2026-03-05 08:00:00 +0000"/>`;
    const xml = writeXml(records);

    await streamParseExportXml({
      xmlPath: xml,
      userId: USER_ID,
      userTimezone: "Europe/Berlin",
      prisma,
    });
    const second = await streamParseExportXml({
      xmlPath: writeXml(records),
      userId: USER_ID,
      userTimezone: "Europe/Berlin",
      prisma,
    });

    expect(second.cycle.daysUpserted).toBe(1);
    expect(second.cycle.daysInserted).toBe(0); // already existed
    const count = await prisma.cycleDayLog.count({
      where: { userId: USER_ID },
    });
    expect(count).toBe(1);
  });

  it("skips the cycle fold entirely for a non-cycle account", async () => {
    const prisma = getPrismaClient();
    await prisma.user.update({
      where: { id: USER_ID },
      data: { gender: "MALE" },
    });
    const xml = writeXml(
      `<Record type="HKCategoryTypeIdentifierMenstrualFlow" value="HKCategoryValueMenstrualFlowLight" startDate="2026-03-02 08:00:00 +0000" endDate="2026-03-02 08:00:00 +0000"/>`,
    );

    const result = await streamParseExportXml({
      xmlPath: xml,
      userId: USER_ID,
      userTimezone: "Europe/Berlin",
      prisma,
    });

    // Sample was bucketed but the gate suppressed the flush.
    expect(result.cycle.daysUpserted).toBe(0);
    const count = await prisma.cycleDayLog.count({
      where: { userId: USER_ID },
    });
    expect(count).toBe(0);
  });
});

describe("cycle backup — round-trips through build + restore", () => {
  it("carries the note readable and re-seals it, with symptom links by key", async () => {
    const prisma = getPrismaClient();

    const cycle = await prisma.menstrualCycle.create({
      data: {
        userId: USER_ID,
        startDate: "2026-03-01",
        endDate: "2026-03-28",
        periodEndDate: "2026-03-05",
        lengthDays: 28,
      },
    });
    const dayLog = await prisma.cycleDayLog.create({
      data: {
        userId: USER_ID,
        date: "2026-03-02",
        flow: "MEDIUM",
        cycleId: cycle.id,
        cervixPosition: "HIGH",
        cervixFirmness: "SOFT",
        cervixOpening: "OPEN",
        notesEncrypted: encrypt("Cramps in the evening"),
        source: "MANUAL",
      },
    });
    const symptom = await prisma.cycleSymptom.findUniqueOrThrow({
      where: { key: "cramps" },
    });
    await prisma.cycleSymptomLink.create({
      data: { dayLogId: dayLog.id, symptomId: symptom.id },
    });
    await prisma.cycleProfile.create({
      data: {
        userId: USER_ID,
        goal: "TRYING_TO_CONCEIVE",
        cycleTrackingEnabled: true,
        secondarySymptom: "CERVIX",
      },
    });

    // Build the backup section, then assert it round-trips through the schema.
    const section = await buildCycleBackupSection(prisma, USER_ID);
    expect(section.cycles).toHaveLength(1);
    expect(section.cycleDayLogs).toHaveLength(1);
    // A portable section carries the note readable, never the ciphertext.
    expect(section.cycleDayLogs[0].note).toBe("Cramps in the evening");
    expect(section.cycleDayLogs[0]).not.toHaveProperty("notesEncrypted");
    expect(section.cycleDayLogs[0].symptomKeys).toEqual(["cramps"]);

    const payload = parseBackupPayload({
      schemaVersion: "1",
      exportedAt: new Date().toISOString(),
      userId: USER_ID,
      ...section,
    });

    // Restore into a clean transaction (wipes then recreates).
    const skips: RestoreSkipLog = [];
    await prisma.$transaction(async (tx) => {
      await restoreCycleData(tx, USER_ID, payload, skips);
    });
    // A file whose every symptom resolves reports nothing skipped. Absence
    // reading as absence cuts both ways: the report has to stay empty when
    // nothing was lost, or an operator learns to ignore it.
    expect(skips).toEqual([]);

    const restored = await prisma.cycleDayLog.findMany({
      where: { userId: USER_ID },
      include: { symptomLinks: { include: { symptom: true } } },
    });
    expect(restored).toHaveLength(1);
    expect(decrypt(restored[0].notesEncrypted!)).toBe("Cramps in the evening");
    expect(restored[0].cervixPosition).toBe("HIGH");
    expect(restored[0].cervixFirmness).toBe("SOFT");
    expect(restored[0].cervixOpening).toBe("OPEN");
    expect(restored[0].cycleId).not.toBeNull();
    expect(restored[0].symptomLinks.map((l) => l.symptom.key)).toEqual([
      "cramps",
    ]);

    const profile = await prisma.cycleProfile.findUniqueOrThrow({
      where: { userId: USER_ID },
    });
    expect(profile.goal).toBe("TRYING_TO_CONCEIVE");
    expect(profile.secondarySymptom).toBe("CERVIX");
  });
});
