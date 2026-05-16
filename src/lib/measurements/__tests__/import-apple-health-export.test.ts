import { describe, expect, it } from "vitest";
import { writeFileSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  hashSampleKey,
  parseRecordValue,
  streamParseExportXml,
  SLEEP_STAGE_NAME_TO_CODEPOINT,
  APPLE_HEALTH_SLEEP_STAGE_MAP,
  type ImportJobProgress,
} from "../import-apple-health-export";

/**
 * Build a minimal hand-authored `export.xml` covering the surface area
 * the parser must handle end-to-end: spot quantity (weight), cumulative
 * quantity (steps), sleep stage, audio-exposure event, workout,
 * deferred identifier, unknown identifier, clinical record.
 */
function tinyExportXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE HealthData [<!ELEMENT HealthData (Record|Workout|ClinicalRecord)*>]>
<HealthData locale="en_US">
  <ExportDate value="2026-05-15 14:32:01 +0200"/>
  <Me HKCharacteristicTypeIdentifierDateOfBirth="1985-06-12"/>

  <Record type="HKQuantityTypeIdentifierBodyMass"
          unit="kg"
          startDate="2026-05-14 08:13:00 +0200"
          endDate="2026-05-14 08:14:00 +0200"
          value="78.4"
          sourceName="Withings Scale"
          sourceVersion="2.4.1"/>

  <Record type="HKQuantityTypeIdentifierStepCount"
          unit="count"
          startDate="2026-05-14 08:00:00 +0200"
          endDate="2026-05-14 08:30:00 +0200"
          value="1500"
          sourceName="Marc's iPhone"
          sourceVersion="17.4.1"/>

  <Record type="HKQuantityTypeIdentifierStepCount"
          unit="count"
          startDate="2026-05-14 12:00:00 +0200"
          endDate="2026-05-14 12:30:00 +0200"
          value="3500"
          sourceName="Marc's iPhone"
          sourceVersion="17.4.1"/>

  <Record type="HKCategoryTypeIdentifierSleepAnalysis"
          unit=""
          startDate="2026-05-14 23:00:00 +0200"
          endDate="2026-05-15 06:30:00 +0200"
          value="HKCategoryValueSleepAnalysisAsleepDeep"
          sourceName="Apple Watch"
          sourceVersion="11.2"/>

  <Workout workoutActivityType="HKWorkoutActivityTypeRunning"
           duration="42.0"
           durationUnit="min"
           totalDistance="6.5"
           totalDistanceUnit="km"
           totalEnergyBurned="412"
           totalEnergyBurnedUnit="kcal"
           startDate="2026-05-14 18:00:00 +0200"
           endDate="2026-05-14 18:42:00 +0200"
           sourceName="Apple Watch"/>

  <Record type="HKQuantityTypeIdentifierDietaryWater"
          unit="L"
          startDate="2026-05-14 10:00:00 +0200"
          endDate="2026-05-14 10:00:00 +0200"
          value="0.5"
          sourceName="Health app"/>

  <Record type="HKQuantityTypeIdentifierFutureTypeXYZ"
          unit="??"
          startDate="2026-05-14 10:00:00 +0200"
          endDate="2026-05-14 10:00:00 +0200"
          value="1"/>

  <ClinicalRecord type="HKClinicalTypeIdentifierLabResultRecord"
                  identifier="lab-1"
                  fhirResource="{}"/>
</HealthData>`;
}

/**
 * In-memory Prisma stand-in. The parser calls only the `measurement`
 * and `workout` model methods documented on `StreamParseInput.prisma`;
 * we mimic just those.
 */
function makeFakePrisma() {
  type Row = Record<string, unknown>;
  const measurements: Row[] = [];
  const workouts: Row[] = [];

  return {
    _measurements: measurements,
    _workouts: workouts,
    measurement: {
      findMany: async ({
        where,
      }: {
        where: { userId: string; source: string; OR: Array<Record<string, unknown>> };
      }) => {
        return measurements.filter((m) => {
          if (m.userId !== where.userId || m.source !== where.source) return false;
          return where.OR.some(
            (clause) => m.type === clause.type && m.externalId === clause.externalId,
          );
        }).map((m) => ({ type: m.type, externalId: m.externalId }));
      },
      findUnique: async ({
        where,
      }: {
        where: { userId_type_source_externalId: Record<string, unknown> };
      }) => {
        const key = where.userId_type_source_externalId;
        return measurements.find(
          (m) =>
            m.userId === key.userId
            && m.type === key.type
            && m.source === key.source
            && m.externalId === key.externalId,
        ) ?? null;
      },
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { userId_type_source_externalId: Record<string, unknown> };
        create: Row;
        update: Row;
      }) => {
        const key = where.userId_type_source_externalId;
        const idx = measurements.findIndex(
          (m) =>
            m.userId === key.userId
            && m.type === key.type
            && m.source === key.source
            && m.externalId === key.externalId,
        );
        if (idx >= 0) {
          measurements[idx] = { ...measurements[idx], ...update };
          return measurements[idx];
        }
        measurements.push(create);
        return create;
      },
    },
    workout: {
      findMany: async ({
        where,
      }: {
        where: { userId: string; source: string; externalId: { in: string[] } };
      }) => {
        return workouts.filter(
          (w) =>
            w.userId === where.userId
            && w.source === where.source
            && where.externalId.in.includes(w.externalId as string),
        ).map((w) => ({ externalId: w.externalId }));
      },
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { userId_source_externalId: Record<string, unknown> };
        create: Row;
        update: Row;
      }) => {
        const key = where.userId_source_externalId;
        const idx = workouts.findIndex(
          (w) =>
            w.userId === key.userId
            && w.source === key.source
            && w.externalId === key.externalId,
        );
        if (idx >= 0) {
          workouts[idx] = { ...workouts[idx], ...update };
          return workouts[idx];
        }
        workouts.push(create);
        return create;
      },
    },
  };
}

describe("parseRecordValue", () => {
  it("parses a quantity-record float value", () => {
    expect(
      parseRecordValue(
        "HKQuantityTypeIdentifierBodyMass",
        "78.4",
        "2026-05-14 08:13:00 +0200",
        "2026-05-14 08:14:00 +0200",
      ),
    ).toEqual({ value: 78.4 });
  });

  it("maps a sleep-stage symbolic name to its integer codepoint", () => {
    const result = parseRecordValue(
      "HKCategoryTypeIdentifierSleepAnalysis",
      "HKCategoryValueSleepAnalysisAsleepDeep",
      "2026-05-14 23:00:00 +0200",
      "2026-05-15 06:30:00 +0200",
    );
    expect(result?.sleepStage).toBe(4);
    // duration should be (6:30 + 1 day - 23:00) = 7h30m = 450 minutes
    expect(result?.value).toBeGreaterThan(449);
    expect(result?.value).toBeLessThan(451);
  });

  it("returns null for an unparseable quantity", () => {
    expect(
      parseRecordValue(
        "HKQuantityTypeIdentifierBodyMass",
        "not-a-number",
        "2026-05-14 08:13:00 +0200",
        "2026-05-14 08:14:00 +0200",
      ),
    ).toBeNull();
  });

  it("treats audio-exposure events as 1-count categoricals", () => {
    const result = parseRecordValue(
      "HKCategoryTypeIdentifierEnvironmentalAudioExposureEvent",
      "",
      "2026-05-14 12:00:00 +0200",
      "2026-05-14 12:00:00 +0200",
    );
    expect(result).toEqual({ value: 1 });
  });
});

describe("SLEEP_STAGE_NAME_TO_CODEPOINT", () => {
  it("round-trips with APPLE_HEALTH_SLEEP_STAGE_MAP", () => {
    // Every value in the name map must resolve via the canonical
    // codepoint map back to a SleepStage.
    for (const [name, codepoint] of Object.entries(
      SLEEP_STAGE_NAME_TO_CODEPOINT,
    )) {
      const stage = APPLE_HEALTH_SLEEP_STAGE_MAP[codepoint];
      expect(stage, `${name} → ${codepoint}`).toBeDefined();
    }
  });
});

describe("hashSampleKey", () => {
  it("returns a stable short hash for the same inputs", () => {
    const a = hashSampleKey("HKQuantityTypeIdentifierBodyMass", "78.4",
      "2026-05-14 08:13:00 +0200", "2026-05-14 08:14:00 +0200");
    const b = hashSampleKey("HKQuantityTypeIdentifierBodyMass", "78.4",
      "2026-05-14 08:13:00 +0200", "2026-05-14 08:14:00 +0200");
    expect(a).toBe(b);
    expect(a).toMatch(/^sample:[0-9a-f]{28}$/);
  });

  it("differs when any input differs", () => {
    const a = hashSampleKey("HKQuantityTypeIdentifierBodyMass", "78.4",
      "2026-05-14 08:13:00 +0200", "2026-05-14 08:14:00 +0200");
    const b = hashSampleKey("HKQuantityTypeIdentifierBodyMass", "78.5",
      "2026-05-14 08:13:00 +0200", "2026-05-14 08:14:00 +0200");
    expect(a).not.toBe(b);
  });
});

describe("streamParseExportXml — end-to-end", () => {
  it("ingests the tiny fixture into per-type / workout / deferred / unknown buckets", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "healthlog-parser-test-"));
    const xmlPath = join(tmp, "export.xml");
    writeFileSync(xmlPath, tinyExportXml());

    const prisma = makeFakePrisma();
    const progressSnapshots: ImportJobProgress[] = [];

    const result = await streamParseExportXml({
      xmlPath,
      userId: "user-1",
      userTimezone: "Europe/Berlin",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: prisma as any,
      onProgress: (snap) => {
        progressSnapshots.push(snap);
      },
      spotBatchSize: 2,
      workoutBatchSize: 1,
    });

    // Spot row — weight upsert landed
    expect(result.perType.WEIGHT?.inserted).toBe(1);
    expect(result.perType.WEIGHT?.updated).toBe(0);

    // Cumulative — both step records collapsed into one daily bucket
    expect(result.perType.ACTIVITY_STEPS?.inserted).toBe(1);
    expect(result.perType.ACTIVITY_STEPS?.read).toBe(2);
    // The flushed daily-stats row should sum the two records:
    const stepsRow = prisma._measurements.find(
      (m) => m.type === "ACTIVITY_STEPS",
    );
    expect(stepsRow?.value).toBe(5000);
    expect(stepsRow?.externalId).toMatch(
      /^stats:HKQuantityTypeIdentifierStepCount:\d{4}-\d{2}-\d{2}$/,
    );

    // Sleep — translated through the sleep-stage table
    expect(result.perType.SLEEP_DURATION?.inserted).toBe(1);

    // Workout — single running entry
    expect(result.workouts.read).toBe(1);
    expect(result.workouts.inserted).toBe(1);
    expect(result.workouts.unknownActivityType).toBe(0);
    const workoutRow = prisma._workouts[0];
    expect(workoutRow?.sportType).toBe("running");
    // 6.5 km → 6500 m
    expect(workoutRow?.totalDistanceM).toBe(6500);

    // Deferred identifier — DietaryWater landed in deferred, not unknown
    expect(result.deferred.HKQuantityTypeIdentifierDietaryWater).toBe(1);
    expect(result.unknown.HKQuantityTypeIdentifierDietaryWater).toBeUndefined();

    // Unknown identifier — surfaced under unknown
    expect(result.unknown.HKQuantityTypeIdentifierFutureTypeXYZ).toBe(1);

    // Clinical record — skipped
    expect(result.clinical.skipped).toBe(1);

    // Progress hook fired at least once
    expect(progressSnapshots.length).toBeGreaterThan(0);
    // Totals consistent
    expect(result.totals.recordsRead).toBeGreaterThanOrEqual(7);
  });

  it("re-importing the same export reports 0 inserts and N updates", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "healthlog-parser-test-"));
    const xmlPath = join(tmp, "export.xml");
    writeFileSync(xmlPath, tinyExportXml());
    const prisma = makeFakePrisma();

    await streamParseExportXml({
      xmlPath,
      userId: "user-1",
      userTimezone: "Europe/Berlin",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: prisma as any,
    });

    const secondRun = await streamParseExportXml({
      xmlPath,
      userId: "user-1",
      userTimezone: "Europe/Berlin",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: prisma as any,
    });

    // Second run — every row that landed the first time should
    // update rather than insert.
    expect(secondRun.perType.WEIGHT?.inserted).toBe(0);
    expect(secondRun.perType.WEIGHT?.updated).toBe(1);
    expect(secondRun.perType.ACTIVITY_STEPS?.inserted).toBe(0);
    expect(secondRun.perType.ACTIVITY_STEPS?.updated).toBe(1);
    expect(secondRun.workouts.inserted).toBe(0);
    expect(secondRun.workouts.updated).toBe(1);
  });
});

/**
 * Streaming-memory ceiling: synthesise a ~5 MB export and assert peak
 * heap stays bounded. Smaller than the §11 §5 fixture goal (50 MB) to
 * keep CI iteration fast; the property under test is identical.
 */
describe("streamParseExportXml — memory ceiling", () => {
  it("bounded peak heap on a multi-thousand-row synthetic export", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "healthlog-parser-test-"));
    const xmlPath = join(tmp, "export.xml");

    // ~10 000 step records — each ~250 bytes → ~2.5 MB. Synthetic
    // timestamps walk seconds within a single day so every record has
    // a valid wall-clock and lands in the same cumulative bucket.
    const header =
      `<?xml version="1.0" encoding="UTF-8"?>\n`
      + `<!DOCTYPE HealthData [<!ELEMENT HealthData (Record)*>]>\n`
      + `<HealthData locale="en_US">\n`;
    const footer = `</HealthData>\n`;
    const rows: string[] = [];
    for (let i = 0; i < 10_000; i++) {
      const hour = Math.floor(i / 3600) % 24;
      const minute = Math.floor((i % 3600) / 60);
      const second = i % 60;
      const ts = `2026-05-14 ${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}:${second.toString().padStart(2, "0")} +0200`;
      rows.push(
        `<Record type="HKQuantityTypeIdentifierStepCount"`
        + ` unit="count"`
        + ` startDate="${ts}"`
        + ` endDate="${ts}"`
        + ` value="${(i % 200) + 1}"/>\n`,
      );
    }
    writeFileSync(xmlPath, header + rows.join("") + footer);
    const bytes = readFileSync(xmlPath).length;
    expect(bytes).toBeGreaterThan(1_000_000);

    const beforeHeap = process.memoryUsage().heapUsed;
    const prisma = makeFakePrisma();
    const result = await streamParseExportXml({
      xmlPath,
      userId: "user-1",
      userTimezone: "Europe/Berlin",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: prisma as any,
    });
    const afterHeap = process.memoryUsage().heapUsed;
    const heapDelta = afterHeap - beforeHeap;

    expect(result.totals.recordsRead).toBe(10_000);
    expect(result.perType.ACTIVITY_STEPS?.read).toBe(10_000);
    // The cumulative fold collapses all 10 000 records into one daily
    // bucket (they all land on the same date in the fixture).
    expect(result.perType.ACTIVITY_STEPS?.inserted).toBe(1);

    // Heap delta should be modest — we tolerate a generous 100 MB so a
    // GC-related spike doesn't flake the test, but a regression that
    // buffers per-record would push us above this ceiling fast.
    expect(heapDelta).toBeLessThan(100 * 1024 * 1024);
  });
});
