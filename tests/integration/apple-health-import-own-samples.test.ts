/**
 * The Apple Health export must not bring back what HealthLog wrote into Apple
 * Health itself.
 *
 * The iOS app writes manual entries into Apple Health, and mirrors Withings and
 * import rows into it, each stamped with `dev.healthlog.app.origin = healthlog`.
 * The server already holds those readings under their own source, so the same
 * sample arriving through an export is a second copy: the series shows it
 * twice and the rollups count it twice.
 *
 * Asserted against a real Postgres:
 *   - a record carrying the marker and a row id of this account is left out,
 *     and counted; the marker alone proves nothing about this account (a move
 *     to a new instance without a backup), so a marked record whose id is
 *     missing, unknown or another account's is imported, a deleted row of this
 *     account still counts, and a marked cycle day counts only when the
 *     account holds a day-log on it;
 *   - a record without it lands as before;
 *   - the marker is read from a child `<MetadataEntry>` that follows the
 *     record's open tag, so the record is committed at its close tag;
 *   - a sample from before the marker carries the HealthLog row id as
 *     `HKExternalUUID`; a hit on one of the account's rows of the same kind
 *     leaves it out, either id of a blood pressure pair covering both halves;
 *   - a manual entry mirrored with neither (a MANUAL row with the same type and
 *     value within 2 s) is left out and counted separately;
 *   - a MANUAL row with another value, or 3 s away, is not a match;
 *   - a Withings row of the same value and time is not a match either (those
 *     are mirrored with their row id, so a match would only add false
 *     positives);
 *   - the value match asks nothing for a type the account has no MANUAL rows
 *     of, and each sample left out is counted once.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import { streamParseExportXml } from "@/lib/measurements/import-apple-health-export";

const prisma = getPrismaClient();

beforeEach(async () => {
  await truncateAllTables(prisma);
});

function writeXml(records: string): string {
  const dir = mkdtempSync(join(tmpdir(), "healthlog-import-own-"));
  const xmlPath = join(dir, "export.xml");
  writeFileSync(
    xmlPath,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE HealthData [<!ELEMENT HealthData (Record)*>]>
<HealthData locale="en_US">
${records}
</HealthData>`,
  );
  return xmlPath;
}

const weight = (value: number, end: string, children = "") =>
  `  <Record type="HKQuantityTypeIdentifierBodyMass" sourceName="Health" unit="kg" startDate="${end}" endDate="${end}" value="${value}">${children}</Record>`;
const MARKER = `<MetadataEntry key="dev.healthlog.app.origin" value="healthlog"/>`;
const ext = (id: string) =>
  `<MetadataEntry key="HKExternalUUID" value="${id}"/>`;
/** The row the app mirrored: a weight of this account, its id on the sample. */
const OWN_WEIGHT_ID = "own-weight-row";
const OWN_SYS_ID = "own-sys-row";
const OWN = `${MARKER}${ext(OWN_WEIGHT_ID)}`;
const OWN_BP = `${MARKER}${ext(OWN_SYS_ID)}`;
const OTHER = `<MetadataEntry key="HKWasUserEntered" value="1"/>`;

/**
 * A row of this account the samples point at. Withings and ten minutes off the
 * samples, so neither the series under test nor the manual-value match sees it.
 */
async function seedOwnRow(
  userId: string,
  id: string,
  type: "WEIGHT" | "BLOOD_PRESSURE_SYS" | "ACTIVITY_STEPS",
  deletedAt: Date | null = null,
) {
  await prisma.measurement.create({
    data: {
      id,
      userId,
      type,
      value: type === "ACTIVITY_STEPS" ? 1000 : 70,
      unit:
        type === "WEIGHT" ? "kg" : type === "ACTIVITY_STEPS" ? "steps" : "mmHg",
      source: "WITHINGS",
      measuredAt: new Date("2026-05-14T06:10:00.000Z"),
      deletedAt,
    },
  });
}

async function run(records: string) {
  const user = await prisma.user.create({
    data: { username: "own-samples", email: "own@example.test", role: "USER" },
  });
  await seedOwnRow(user.id, OWN_WEIGHT_ID, "WEIGHT");
  const result = await streamParseExportXml({
    xmlPath: writeXml(records),
    userId: user.id,
    userTimezone: "Europe/Berlin",
    prisma,
  });
  const rows = await prisma.measurement.findMany({
    where: { userId: user.id, type: "WEIGHT", source: "APPLE_HEALTH" },
    orderBy: { measuredAt: "asc" },
  });
  return { user, result, rows };
}

describe("a record HealthLog wrote itself (the origin marker)", () => {
  it("is left out and counted; an ordinary record still lands", async () => {
    const { result, rows } = await run(
      [
        weight(80.1, "2026-05-14 08:00:00 +0200", `\n    ${OWN}\n  `),
        weight(80.2, "2026-05-14 09:00:00 +0200", `\n    ${OTHER}\n  `),
        weight(80.3, "2026-05-14 10:00:00 +0200"),
      ].join("\n"),
    );
    expect(rows.map((r) => r.value)).toEqual([80.2, 80.3]);
    expect(result.writtenByHealthLog).toEqual({
      byMarker: 1,
      byExternalId: 0,
      matchedManual: 0,
    });
  });

  it("finds the marker among other metadata entries", async () => {
    const { result, rows } = await run(
      weight(80.1, "2026-05-14 08:00:00 +0200", `\n  ${OTHER}\n  ${OWN}\n`),
    );
    expect(rows).toHaveLength(0);
    expect(result.writtenByHealthLog.byMarker).toBe(1);
  });

  it("does not let one record's marker spill onto the next", async () => {
    const { rows } = await run(
      [
        weight(80.1, "2026-05-14 08:00:00 +0200", `\n  ${OWN}\n`),
        weight(80.2, "2026-05-14 09:00:00 +0200"),
      ].join("\n"),
    );
    expect(rows.map((r) => r.value)).toEqual([80.2]);
  });

  it("needs the exact value: another origin does not count", async () => {
    const { rows } = await run(
      weight(
        80.1,
        "2026-05-14 08:00:00 +0200",
        `<MetadataEntry key="dev.healthlog.app.origin" value="other"/>`,
      ),
    );
    expect(rows).toHaveLength(1);
  });
});

const bpRecord = (
  type: "Systolic" | "Diastolic",
  value: number,
  at: string,
  children = "",
) =>
  `    <Record type="HKQuantityTypeIdentifierBloodPressure${type}" sourceName="Health" unit="mmHg" startDate="${at}" endDate="${at}" value="${value}">${children}</Record>`;
const correlation = (inner: string, children = "") =>
  `  <Correlation type="HKCorrelationTypeIdentifierBloodPressure" sourceName="Health" startDate="2026-05-14 08:00:00 +0200" endDate="2026-05-14 08:00:00 +0200">${children}\n${inner}\n  </Correlation>`;

describe("blood pressure correlations and self-closing records", () => {
  const AT = "2026-05-14 08:00:00 +0200";
  async function runBp(records: string) {
    const user = await prisma.user.create({
      data: { username: "own-bp", email: "bp@example.test", role: "USER" },
    });
    await seedOwnRow(user.id, OWN_SYS_ID, "BLOOD_PRESSURE_SYS");
    const result = await streamParseExportXml({
      xmlPath: writeXml(records),
      userId: user.id,
      userTimezone: "Europe/Berlin",
      prisma,
    });
    const rows = await prisma.measurement.findMany({
      where: {
        userId: user.id,
        source: "APPLE_HEALTH",
        type: { in: ["BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA"] },
      },
      orderBy: [{ type: "asc" }],
    });
    return { result, values: rows.map((r) => r.value) };
  }

  it("imports an unmarked correlation's two records", async () => {
    const { values, result } = await runBp(
      correlation(
        [bpRecord("Systolic", 121, AT), bpRecord("Diastolic", 79, AT)].join(
          "\n",
        ),
      ),
    );
    expect(values).toEqual([121, 79]);
    expect(result.writtenByHealthLog.byMarker).toBe(0);
  });

  it("leaves out both records when the marker is on the correlation, before them", async () => {
    const { values, result } = await runBp(
      correlation(
        [bpRecord("Systolic", 121, AT), bpRecord("Diastolic", 79, AT)].join(
          "\n",
        ),
        `\n    ${OWN_BP}`,
      ),
    );
    expect(values).toEqual([]);
    expect(result.writtenByHealthLog.byMarker).toBe(2);
  });

  it("leaves out both records when the marker is on the correlation, after them", async () => {
    const records = [
      bpRecord("Systolic", 121, AT),
      bpRecord("Diastolic", 79, AT),
    ].join("\n");
    const { values } = await runBp(
      `  <Correlation type="HKCorrelationTypeIdentifierBloodPressure" sourceName="Health" startDate="${AT}" endDate="${AT}">\n${records}\n    ${OWN_BP}\n  </Correlation>`,
    );
    expect(values).toEqual([]);
  });

  it("leaves out only the record that carries the marker", async () => {
    const { values } = await runBp(
      correlation(
        [
          bpRecord("Systolic", 121, AT, `\n      ${OWN_BP}\n    `),
          bpRecord("Diastolic", 79, AT),
        ].join("\n"),
      ),
    );
    expect(values).toEqual([79]);
  });

  it("does not let a correlation's marker spill onto the next record", async () => {
    const { values } = await runBp(
      [
        correlation(
          [bpRecord("Systolic", 121, AT), bpRecord("Diastolic", 79, AT)].join(
            "\n",
          ),
          `\n    ${OWN_BP}`,
        ),
        bpRecord("Systolic", 130, "2026-05-14 09:00:00 +0200"),
      ].join("\n"),
    );
    expect(values).toEqual([130]);
  });

  it("imports a self-closing record, with no children to wait for", async () => {
    const { rows } = await run(
      `  <Record type="HKQuantityTypeIdentifierBodyMass" sourceName="Health" unit="kg" startDate="${AT}" endDate="${AT}" value="80.9"/>`,
    );
    expect(rows.map((r) => r.value)).toEqual([80.9]);
  });
});

describe("the synthetic export fixture", () => {
  // `export-own-origin.synthetic.xml` is invented, in the shape Apple's DTD
  // documents. It shows the parser reads a file laid out like an export; it
  // cannot show that Apple writes a custom metadata key verbatim.
  it("leaves out the marked record this account holds and imports the other four", async () => {
    const user = await prisma.user.create({
      data: { username: "own-fixture", email: "fx@example.test", role: "USER" },
    });
    await seedOwnRow(user.id, "00000000-0000-0000-0000-000000000001", "WEIGHT");
    const result = await streamParseExportXml({
      xmlPath: join(
        process.cwd(),
        "tests/fixtures/apple-health/export-own-origin.synthetic.xml",
      ),
      userId: user.id,
      userTimezone: "Europe/Berlin",
      prisma,
    });
    const rows = await prisma.measurement.findMany({
      where: { userId: user.id, type: "WEIGHT", source: "APPLE_HEALTH" },
      orderBy: { measuredAt: "asc" },
    });
    expect(rows.map((r) => r.value)).toEqual([80.2, 80.3, 80.4, 80.5]);
    expect(result.writtenByHealthLog).toEqual({
      byMarker: 1,
      byExternalId: 0,
      matchedManual: 0,
    });
  });
});

describe("a manual entry mirrored before the marker existed", () => {
  async function runAgainst(
    manual: { value: number; at: string; source?: "MANUAL" | "WITHINGS" },
    record: { value: number; at: string },
  ) {
    const user = await prisma.user.create({
      data: { username: "own-fallback", email: "f@example.test", role: "USER" },
    });
    await prisma.measurement.create({
      data: {
        userId: user.id,
        type: "WEIGHT",
        unit: "kg",
        source: manual.source ?? "MANUAL",
        value: manual.value,
        measuredAt: new Date(manual.at),
      },
    });
    const result = await streamParseExportXml({
      xmlPath: writeXml(weight(record.value, "2026-05-14 08:00:00 +0200")),
      userId: user.id,
      userTimezone: "Europe/Berlin",
      prisma,
    });
    const rows = await prisma.measurement.findMany({
      where: { userId: user.id, type: "WEIGHT", source: "APPLE_HEALTH" },
    });
    return { result, rows };
  }

  it("is left out when a MANUAL row has the same value within 2 s", async () => {
    const { result, rows } = await runAgainst(
      { value: 80.4, at: "2026-05-14T06:00:01.500Z" },
      { value: 80.4, at: "" },
    );
    expect(rows).toHaveLength(0);
    expect(result.writtenByHealthLog).toEqual({
      byMarker: 0,
      byExternalId: 0,
      matchedManual: 1,
    });
  });

  it("is kept when the value differs", async () => {
    const { result, rows } = await runAgainst(
      { value: 80.9, at: "2026-05-14T06:00:00.000Z" },
      { value: 80.4, at: "" },
    );
    expect(rows).toHaveLength(1);
    expect(result.writtenByHealthLog.matchedManual).toBe(0);
  });

  it("is kept when the MANUAL row is 3 s away", async () => {
    const { rows } = await runAgainst(
      { value: 80.4, at: "2026-05-14T06:00:03.000Z" },
      { value: 80.4, at: "" },
    );
    expect(rows).toHaveLength(1);
  });

  it("is kept against a Withings row of the same value and time", async () => {
    const { result, rows } = await runAgainst(
      { value: 80.4, at: "2026-05-14T06:00:00.000Z", source: "WITHINGS" },
      { value: 80.4, at: "" },
    );
    expect(rows).toHaveLength(1);
    expect(result.writtenByHealthLog.matchedManual).toBe(0);
  });
});

/**
 * Count every `measurement.findMany` the import issues against MANUAL rows,
 * by wrapping the client the import is handed.
 */
function countingManualQueries() {
  const manualQueries: Array<{ where?: Record<string, unknown> }> = [];
  const measurement = new Proxy(prisma.measurement, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop !== "findMany" || typeof value !== "function") return value;
      return (args: { where?: Record<string, unknown> }) => {
        if (args?.where?.source === "MANUAL") manualQueries.push(args);
        return value.call(target, args);
      };
    },
  });
  const client = new Proxy(prisma, {
    get(target, prop, receiver) {
      if (prop === "measurement") return measurement;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as typeof prisma;
  return { client, manualQueries };
}

describe("the manual-mirror lookup stays off the hot path", () => {
  const AT = (i: number) =>
    `2026-05-14 ${String(8 + Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00 +0200`;
  const heartRate = (value: number, at: string) =>
    `  <Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Health" unit="count/min" startDate="${at}" endDate="${at}" value="${value}"/>`;

  async function runCounting(records: string, manualType?: "WEIGHT") {
    const user = await prisma.user.create({
      data: { username: "own-hot", email: "hot@example.test", role: "USER" },
    });
    if (manualType) {
      await prisma.measurement.create({
        data: {
          userId: user.id,
          type: manualType,
          unit: "kg",
          source: "MANUAL",
          value: 80.4,
          measuredAt: new Date("2026-05-14T06:00:00.000Z"),
        },
      });
    }
    const { client, manualQueries } = countingManualQueries();
    const result = await streamParseExportXml({
      xmlPath: writeXml(records),
      userId: user.id,
      userTimezone: "Europe/Berlin",
      prisma: client,
      spotBatchSize: 10,
    });
    return { result, manualQueries, user };
  }

  it("asks nothing per batch when the account has no MANUAL rows", async () => {
    const records = Array.from({ length: 40 }, (_, i) =>
      heartRate(60 + (i % 20), AT(i)),
    ).join("\n");
    const { manualQueries, result } = await runCounting(records);
    expect(manualQueries).toHaveLength(0);
    expect(result.writtenByHealthLog.matchedManual).toBe(0);
  });

  it("asks nothing for a type without MANUAL rows, and one bounded window per batch for one with them", async () => {
    const records = [
      ...Array.from({ length: 40 }, (_, i) => heartRate(60 + (i % 20), AT(i))),
      weight(80.4, "2026-05-14 08:00:00 +0200"),
      weight(80.6, "2026-05-14 09:00:00 +0200"),
    ].join("\n");
    const { manualQueries, result, user } = await runCounting(
      records,
      "WEIGHT",
    );
    // The heart rates ask nothing; the weights ask once, with one window for
    // their type, not one clause per row.
    expect(manualQueries).toHaveLength(1);
    const or = manualQueries[0].where?.OR as Array<{ type: string }>;
    expect(or).toHaveLength(1);
    expect(or[0].type).toBe("WEIGHT");
    // The mirror is still caught; the other weight still lands.
    expect(result.writtenByHealthLog.matchedManual).toBe(1);
    const weights = await prisma.measurement.findMany({
      where: { userId: user.id, type: "WEIGHT", source: "APPLE_HEALTH" },
    });
    expect(weights.map((w) => w.value)).toEqual([80.6]);
  });
});

describe("a sample whose HKExternalUUID is a HealthLog row id", () => {
  const AT = "2026-05-14 08:00:00 +0200";

  async function runWith(
    seed: (userId: string) => Promise<Record<string, string>>,
    records: (ids: Record<string, string>) => string,
  ) {
    const user = await prisma.user.create({
      data: { username: "own-ext", email: "ext@example.test", role: "USER" },
    });
    const ids = await seed(user.id);
    const result = await streamParseExportXml({
      xmlPath: writeXml(records(ids)),
      userId: user.id,
      userTimezone: "Europe/Berlin",
      prisma,
    });
    const rows = await prisma.measurement.findMany({
      where: { userId: user.id, source: "APPLE_HEALTH" },
      orderBy: [{ type: "asc" }],
    });
    return { result, rows };
  }

  const seedRow = async (
    userId: string,
    type: "WEIGHT" | "BLOOD_PRESSURE_SYS" | "BLOOD_PRESSURE_DIA",
    value: number,
    source: "MANUAL" | "WITHINGS" = "MANUAL",
  ) =>
    (
      await prisma.measurement.create({
        data: {
          userId,
          type,
          value,
          unit: type === "WEIGHT" ? "kg" : "mmHg",
          source,
          // Ten minutes off the sample: only the id can tie them together.
          measuredAt: new Date("2026-05-14T06:10:00.000Z"),
        },
      })
    ).id;

  it("is left out without the marker, for a Withings row the value match never covers", async () => {
    const { result, rows } = await runWith(
      async (userId) => ({
        w: await seedRow(userId, "WEIGHT", 81, "WITHINGS"),
      }),
      (ids) => weight(80.4, AT, ext(ids.w)),
    );
    expect(rows).toHaveLength(0);
    expect(result.writtenByHealthLog).toEqual({
      byMarker: 0,
      byExternalId: 1,
      matchedManual: 0,
    });
  });

  it("leaves out both halves of a pressure pair stamped with either half's id", async () => {
    const { result, rows } = await runWith(
      async (userId) => ({
        sys: await seedRow(userId, "BLOOD_PRESSURE_SYS", 121),
        dia: await seedRow(userId, "BLOOD_PRESSURE_DIA", 79),
      }),
      (ids) =>
        [
          // Current builds stamp both samples with the systolic id ...
          bpRecord("Systolic", 121, AT, ext(ids.sys)),
          bpRecord("Diastolic", 79, AT, ext(ids.sys)),
          // ... older builds stamped both with the diastolic id.
          bpRecord("Systolic", 122, "2026-05-14 09:00:00 +0200", ext(ids.dia)),
          bpRecord("Diastolic", 80, "2026-05-14 09:00:00 +0200", ext(ids.dia)),
        ].join("\n"),
    );
    expect(rows).toHaveLength(0);
    expect(result.writtenByHealthLog.byExternalId).toBe(4);
  });

  it("is imported when the id is unknown, belongs to another account, or names another kind", async () => {
    const other = await prisma.user.create({
      data: { username: "own-ext-2", email: "ext2@example.test", role: "USER" },
    });
    const foreignId = await seedRow(other.id, "WEIGHT", 80.4);
    const { result, rows } = await runWith(
      async (userId) => ({
        sys: await seedRow(userId, "BLOOD_PRESSURE_SYS", 121),
      }),
      (ids) =>
        [
          weight(80.1, AT, ext("00000000-0000-4000-8000-000000000001")),
          weight(80.2, "2026-05-14 09:00:00 +0200", ext(foreignId)),
          weight(80.3, "2026-05-14 10:00:00 +0200", ext(ids.sys)),
        ].join("\n"),
    );
    expect(rows.map((r) => r.value)).toEqual([80.1, 80.2, 80.3]);
    expect(result.writtenByHealthLog.byExternalId).toBe(0);
  });
});

describe("each sample left out is counted once", () => {
  it("does not count a marked record twice when it appears top level and inside its correlation", async () => {
    const AT = "2026-05-14 08:00:00 +0200";
    const sys = bpRecord("Systolic", 121, AT, `\n      ${OWN_BP}\n    `);
    const dia = bpRecord("Diastolic", 79, AT, `\n      ${OWN_BP}\n    `);
    const user = await prisma.user.create({
      data: { username: "own-once", email: "once@example.test", role: "USER" },
    });
    await seedOwnRow(user.id, OWN_SYS_ID, "BLOOD_PRESSURE_SYS");
    const result = await streamParseExportXml({
      xmlPath: writeXml(
        [sys, dia, correlation([sys, dia].join("\n"))].join("\n"),
      ),
      userId: user.id,
      userTimezone: "Europe/Berlin",
      prisma,
    });
    expect(result.writtenByHealthLog.byMarker).toBe(2);
  });
});

describe("a cycle sample HealthLog wrote itself", () => {
  it("is left out on a day this account holds, imported on a day it does not", async () => {
    const user = await prisma.user.create({
      data: {
        username: "own-cycle",
        email: "cycle@example.test",
        role: "USER",
        gender: "FEMALE",
        timezone: "Europe/Berlin",
      },
    });
    // The day the app mirrored from: a day-log of this account.
    await prisma.cycleDayLog.create({
      data: { userId: user.id, date: "2026-03-02", flow: "MEDIUM" },
    });
    const flow = (day: string, children = "") =>
      `  <Record type="HKCategoryTypeIdentifierMenstrualFlow" sourceName="Health" value="HKCategoryValueMenstrualFlowMedium" startDate="${day} 08:00:00 +0000" endDate="${day} 08:00:00 +0000">${children}</Record>`;
    const result = await streamParseExportXml({
      xmlPath: writeXml(
        [
          flow("2026-03-02", MARKER),
          flow("2026-03-03"),
          // Marked, but no day-log here: a move to a new instance.
          flow("2026-03-04", MARKER),
        ].join("\n"),
      ),
      userId: user.id,
      userTimezone: "Europe/Berlin",
      prisma,
    });
    const days = await prisma.cycleDayLog.findMany({
      where: { userId: user.id },
      orderBy: { date: "asc" },
    });
    expect(days.map((d) => d.date)).toEqual([
      "2026-03-02",
      "2026-03-03",
      "2026-03-04",
    ]);
    // The held day stays the account's own: the marked sample did not
    // re-import it as an Apple Health day.
    expect(days[0].source).toBe("MANUAL");
    expect(result.writtenByHealthLog.byMarker).toBe(1);
  });
});

describe("a marked record this account does not hold", () => {
  // A move to a new instance without a backup: the export still carries the
  // marker on every value the app mirrored, but none of the rows exist here.
  it("is imported when the id is missing, unknown or another account's", async () => {
    const other = await prisma.user.create({
      data: { username: "own-move-2", email: "mv2@example.test", role: "USER" },
    });
    await seedOwnRow(other.id, "foreign-weight-row", "WEIGHT");
    const user = await prisma.user.create({
      data: { username: "own-move", email: "mv@example.test", role: "USER" },
    });
    const result = await streamParseExportXml({
      xmlPath: writeXml(
        [
          weight(80.1, "2026-05-14 08:00:00 +0200", MARKER),
          weight(
            80.2,
            "2026-05-14 09:00:00 +0200",
            `${MARKER}${ext("00000000-0000-4000-8000-000000000009")}`,
          ),
          weight(
            80.3,
            "2026-05-14 10:00:00 +0200",
            `${MARKER}${ext("foreign-weight-row")}`,
          ),
        ].join("\n"),
      ),
      userId: user.id,
      userTimezone: "Europe/Berlin",
      prisma,
    });
    const rows = await prisma.measurement.findMany({
      where: { userId: user.id, type: "WEIGHT", source: "APPLE_HEALTH" },
      orderBy: { measuredAt: "asc" },
    });
    expect(rows.map((r) => r.value)).toEqual([80.1, 80.2, 80.3]);
    expect(result.writtenByHealthLog).toEqual({
      byMarker: 0,
      byExternalId: 0,
      matchedManual: 0,
    });
  });

  it("is still left out when its id names a deleted row of this account", async () => {
    const user = await prisma.user.create({
      data: {
        username: "own-deleted",
        email: "del@example.test",
        role: "USER",
      },
    });
    await seedOwnRow(user.id, OWN_WEIGHT_ID, "WEIGHT", new Date());
    const result = await streamParseExportXml({
      xmlPath: writeXml(weight(80.1, "2026-05-14 08:00:00 +0200", OWN)),
      userId: user.id,
      userTimezone: "Europe/Berlin",
      prisma,
    });
    const rows = await prisma.measurement.findMany({
      where: { userId: user.id, type: "WEIGHT", source: "APPLE_HEALTH" },
    });
    expect(rows).toHaveLength(0);
    expect(result.writtenByHealthLog.byMarker).toBe(1);
  });

  it("adds a marked cumulative sample to its day unless its id is this account's", async () => {
    const user = await prisma.user.create({
      data: { username: "own-steps", email: "st@example.test", role: "USER" },
    });
    await seedOwnRow(user.id, "own-steps-row", "ACTIVITY_STEPS");
    const steps = (value: number, at: string, children: string) =>
      `  <Record type="HKQuantityTypeIdentifierStepCount" sourceName="Health" unit="count" startDate="${at}" endDate="${at}" value="${value}">${children}</Record>`;
    const result = await streamParseExportXml({
      xmlPath: writeXml(
        [
          steps(
            700,
            "2026-05-14 08:00:00 +0200",
            `${MARKER}${ext("own-steps-row")}`,
          ),
          steps(
            300,
            "2026-05-14 09:00:00 +0200",
            `${MARKER}${ext("not-a-row")}`,
          ),
          steps(200, "2026-05-14 10:00:00 +0200", ""),
        ].join("\n"),
      ),
      userId: user.id,
      userTimezone: "Europe/Berlin",
      prisma,
    });
    const rows = await prisma.measurement.findMany({
      where: {
        userId: user.id,
        type: "ACTIVITY_STEPS",
        source: "APPLE_HEALTH",
      },
    });
    // 300 + 200: the 700 the app mirrored from this account's row stays out.
    expect(rows.map((r) => r.value)).toEqual([500]);
    expect(result.writtenByHealthLog.byMarker).toBe(1);
  });
});
