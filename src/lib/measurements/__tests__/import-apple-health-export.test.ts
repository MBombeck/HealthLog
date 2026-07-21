import { describe, expect, it, vi, beforeEach } from "vitest";
import { writeFileSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("@/lib/arrivals/measurement-emit", () => ({
  emitInsertedMeasurementArrivals: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/daily/morning-refresh-trigger", () => ({
  maybeEnqueueMorningRefresh: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/arrivals/emit-shared", () => ({
  emitDataArrival: vi.fn().mockResolvedValue(undefined),
}));

import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import {
  hashSampleKey,
  parseRecordValue,
  streamParseExportXml,
  SLEEP_STAGE_NAME_TO_CODEPOINT,
  APPLE_HEALTH_SLEEP_STAGE_MAP,
  type ImportJobProgress,
} from "../import-apple-health-export";
import { emitInsertedMeasurementArrivals } from "@/lib/arrivals/measurement-emit";
import { maybeEnqueueMorningRefresh } from "@/lib/daily/morning-refresh-trigger";
import { emitDataArrival } from "@/lib/arrivals/emit-shared";
import {
  APPLE_HEALTH_TYPE_MAP,
  CUMULATIVE_HK_TYPES,
} from "../apple-health-mapping";

beforeEach(() => {
  vi.clearAllMocks();
});

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
          sourceName="Test iPhone"
          sourceVersion="17.4.1"/>

  <Record type="HKQuantityTypeIdentifierStepCount"
          unit="count"
          startDate="2026-05-14 12:00:00 +0200"
          endDate="2026-05-14 12:30:00 +0200"
          value="3500"
          sourceName="Test iPhone"
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
function makeFakePrisma(
  options: {
    measurementRaceExternalIds?: string[];
    workoutRaceExternalIds?: string[];
  } = {},
) {
  type Row = Record<string, unknown>;
  const measurements: Row[] = [];
  const workouts: Row[] = [];
  const measurementRaceExternalIds = new Set(
    options.measurementRaceExternalIds ?? [],
  );
  const workoutRaceExternalIds = new Set(options.workoutRaceExternalIds ?? []);
  const injectedMeasurementRaces = new Set<string>();
  const injectedWorkoutRaces = new Set<string>();
  let nextId = 1;

  // The real `measurements` table carries a SECOND full unique index — the
  // natural key `(userId, type, measuredAt, source, sleepStage)` (migration
  // 0055, NULLS NOT DISTINCT) — on top of the `(userId, type, source,
  // externalId)` one the upsert keys on. Model BOTH so a create that would
  // collide on the natural key raises the exact P2002 the production DB does,
  // which is what the natural-key rescue must catch. `measuredAt` compares by
  // epoch; NULL `sleepStage` collides with NULL (NULLS NOT DISTINCT).
  const sameMeasuredAt = (a: unknown, b: unknown): boolean =>
    a instanceof Date && b instanceof Date
      ? a.getTime() === b.getTime()
      : a === b;
  const sameStage = (a: unknown, b: unknown): boolean =>
    (a ?? null) === (b ?? null);
  const naturalKeyMatch = (m: Row, r: Row): boolean =>
    m.userId === r.userId &&
    m.type === r.type &&
    m.source === r.source &&
    sameMeasuredAt(m.measuredAt, r.measuredAt) &&
    sameStage(m.sleepStage, r.sleepStage);

  const injectMeasurementRace = (create: Row): void => {
    const externalId = String(create.externalId);
    if (
      !measurementRaceExternalIds.has(externalId) ||
      injectedMeasurementRaces.has(externalId)
    ) {
      return;
    }
    injectedMeasurementRaces.add(externalId);
    measurements.push({ id: `m${nextId++}`, ...create });
  };

  const injectWorkoutRace = (create: Row): void => {
    const externalId = String(create.externalId);
    if (
      !workoutRaceExternalIds.has(externalId) ||
      injectedWorkoutRaces.has(externalId)
    ) {
      return;
    }
    injectedWorkoutRaces.add(externalId);
    workouts.push({ id: `w${nextId++}`, ...create });
  };

  const fake = {
    _measurements: measurements,
    _workouts: workouts,
    $queryRaw: async () => [],
    $executeRawUnsafe: async () => 0,
    $transaction: async (
      callback: (tx: unknown) => Promise<unknown>,
    ): Promise<unknown> => callback(fake),
    measurement: {
      create: async ({ data }: { data: Row }) => {
        injectMeasurementRace(data);
        if (
          measurements.some(
            (measurement) =>
              (measurement.userId === data.userId &&
                measurement.type === data.type &&
                measurement.source === data.source &&
                measurement.externalId === data.externalId) ||
              naturalKeyMatch(measurement, data),
          )
        ) {
          throw new Prisma.PrismaClientKnownRequestError(
            "Unique constraint failed",
            { code: "P2002", clientVersion: "test" },
          );
        }
        const created: Row = {
          id: `m${nextId++}`,
          syncVersion: 1,
          deletedAt: null,
          sleepStage: null,
          ...data,
        };
        measurements.push(created);
        return created;
      },
      createManyAndReturn: async ({ data }: { data: Row[] }) => {
        const returned: Row[] = [];
        for (const create of data) {
          injectMeasurementRace(create);
          const externalKeyTaken = measurements.some(
            (m) =>
              m.userId === create.userId &&
              m.type === create.type &&
              m.source === create.source &&
              m.externalId === create.externalId,
          );
          if (
            externalKeyTaken ||
            measurements.some((m) => naturalKeyMatch(m, create))
          ) {
            continue;
          }
          const row: Row = { id: `m${nextId++}`, ...create };
          measurements.push(row);
          returned.push({
            id: row.id,
            type: row.type,
            measuredAt: row.measuredAt,
            externalId: row.externalId,
          });
        }
        return returned;
      },
      findMany: async ({
        where,
      }: {
        where: {
          userId: string;
          source?: unknown;
          OR?: Array<Record<string, unknown>>;
        };
      }) => {
        const externalClause = where.OR?.find(
          (clause) => typeof clause.externalId === "string",
        );
        const externalId =
          typeof externalClause?.externalId === "string"
            ? externalClause.externalId
            : null;
        if (
          externalId?.startsWith("stats:") &&
          measurementRaceExternalIds.has(externalId) &&
          !injectedMeasurementRaces.has(externalId)
        ) {
          const naturalClause = where.OR?.find(
            (clause) => clause.measuredAt instanceof Date,
          );
          injectedMeasurementRaces.add(externalId);
          measurements.push({
            id: `m${nextId++}`,
            userId: where.userId,
            type: externalClause?.type,
            source: externalClause?.source,
            externalId,
            measuredAt: naturalClause?.measuredAt,
            sleepStage: naturalClause?.sleepStage ?? null,
            deletedAt: null,
            syncVersion: 1,
            aggregationProvenance: "HEALTHKIT_STATISTICS",
          });
        }
        return measurements.filter((measurement) => {
          if (measurement.userId !== where.userId) return false;
          if (
            where.source !== undefined &&
            measurement.source !== where.source
          ) {
            return false;
          }
          if (!where.OR) return true;
          return where.OR.some(
            (clause) =>
              (clause.type === undefined || measurement.type === clause.type) &&
              (clause.source === undefined ||
                measurement.source === clause.source) &&
              (clause.externalId === undefined ||
                measurement.externalId === clause.externalId) &&
              (clause.measuredAt === undefined ||
                sameMeasuredAt(measurement.measuredAt, clause.measuredAt)) &&
              (clause.sleepStage === undefined ||
                sameStage(measurement.sleepStage, clause.sleepStage)),
          );
        });
      },
      findUnique: async ({
        where,
      }: {
        where: { userId_type_source_externalId: Record<string, unknown> };
      }) => {
        const key = where.userId_type_source_externalId;
        return (
          measurements.find(
            (m) =>
              m.userId === key.userId &&
              m.type === key.type &&
              m.source === key.source &&
              m.externalId === key.externalId,
          ) ?? null
        );
      },
      // Natural-key probe used by the rescue path. Tombstone-inclusive: no
      // `deletedAt` filter is applied here or by the caller.
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        const excludedId =
          typeof where.id === "object" && where.id !== null && "not" in where.id
            ? where.id.not
            : undefined;
        const match = measurements.find(
          (measurement) =>
            measurement.id !== excludedId &&
            naturalKeyMatch(measurement, where),
        );
        return match ? { id: match.id } : null;
      },
      update: async ({
        where,
        data,
      }: {
        where: {
          id?: unknown;
          userId_type_source_externalId?: Record<string, unknown>;
        };
        data: Row;
      }) => {
        const idx =
          where.id !== undefined
            ? measurements.findIndex((m) => m.id === where.id)
            : measurements.findIndex((m) => {
                const key = where.userId_type_source_externalId;
                return (
                  key !== undefined &&
                  m.userId === key.userId &&
                  m.type === key.type &&
                  m.source === key.source &&
                  m.externalId === key.externalId
                );
              });
        if (idx < 0) {
          throw new Prisma.PrismaClientKnownRequestError(
            "Record to update not found",
            { code: "P2025", clientVersion: "test" },
          );
        }
        const syncVersion =
          typeof data.syncVersion === "object" &&
          data.syncVersion !== null &&
          "increment" in data.syncVersion &&
          typeof data.syncVersion.increment === "number"
            ? Number(measurements[idx].syncVersion ?? 1) +
              data.syncVersion.increment
            : data.syncVersion;
        measurements[idx] = {
          ...measurements[idx],
          ...data,
          ...(syncVersion === undefined ? {} : { syncVersion }),
        };
        return measurements[idx];
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
        injectMeasurementRace(create);
        const idx = measurements.findIndex(
          (m) =>
            m.userId === key.userId &&
            m.type === key.type &&
            m.source === key.source &&
            m.externalId === key.externalId,
        );
        if (idx >= 0) {
          measurements[idx] = { ...measurements[idx], ...update };
          return measurements[idx];
        }
        // The externalId leg missed → this is a create. Enforce the natural-key
        // unique before inserting, exactly as Postgres would.
        if (measurements.some((m) => naturalKeyMatch(m, create))) {
          throw new Prisma.PrismaClientKnownRequestError(
            "Unique constraint failed on the fields: (`user_id`,`type`,`measured_at`,`source`,`sleep_stage`)",
            { code: "P2002", clientVersion: "test" },
          );
        }
        const row = { id: `m${nextId++}`, ...create };
        measurements.push(row);
        return row;
      },
    },
    workout: {
      createManyAndReturn: async ({ data }: { data: Row[] }) => {
        const returned: Row[] = [];
        for (const create of data) {
          injectWorkoutRace(create);
          if (
            workouts.some(
              (w) =>
                w.userId === create.userId &&
                w.source === create.source &&
                w.externalId === create.externalId,
            )
          ) {
            continue;
          }
          const row: Row = { id: `w${nextId++}`, ...create };
          workouts.push(row);
          returned.push({
            id: row.id,
            startedAt: row.startedAt,
            externalId: row.externalId,
          });
        }
        return returned;
      },
      update: async ({
        where,
        data,
      }: {
        where: { userId_source_externalId: Record<string, unknown> };
        data: Row;
      }) => {
        const key = where.userId_source_externalId;
        const idx = workouts.findIndex(
          (w) =>
            w.userId === key.userId &&
            w.source === key.source &&
            w.externalId === key.externalId,
        );
        if (idx < 0) throw new Error("workout row not found");
        workouts[idx] = { ...workouts[idx], ...data };
        return workouts[idx];
      },
      findMany: async ({
        where,
      }: {
        where: { userId: string; source: string; externalId: { in: string[] } };
      }) => {
        return workouts
          .filter(
            (w) =>
              w.userId === where.userId &&
              w.source === where.source &&
              where.externalId.in.includes(w.externalId as string),
          )
          .map((w) => ({ externalId: w.externalId }));
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
        injectWorkoutRace(create);
        const idx = workouts.findIndex(
          (w) =>
            w.userId === key.userId &&
            w.source === key.source &&
            w.externalId === key.externalId,
        );
        if (idx >= 0) {
          workouts[idx] = { ...workouts[idx], ...update };
          return workouts[idx];
        }
        const row = { id: `w${nextId++}`, ...create };
        workouts.push(row);
        return row;
      },
    },
  };
  return fake;
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
    const a = hashSampleKey(
      "HKQuantityTypeIdentifierBodyMass",
      "78.4",
      "2026-05-14 08:13:00 +0200",
      "2026-05-14 08:14:00 +0200",
    );
    const b = hashSampleKey(
      "HKQuantityTypeIdentifierBodyMass",
      "78.4",
      "2026-05-14 08:13:00 +0200",
      "2026-05-14 08:14:00 +0200",
    );
    expect(a).toBe(b);
    expect(a).toMatch(/^sample:[0-9a-f]{28}$/);
  });

  it("differs when any input differs", () => {
    const a = hashSampleKey(
      "HKQuantityTypeIdentifierBodyMass",
      "78.4",
      "2026-05-14 08:13:00 +0200",
      "2026-05-14 08:14:00 +0200",
    );
    const b = hashSampleKey(
      "HKQuantityTypeIdentifierBodyMass",
      "78.5",
      "2026-05-14 08:13:00 +0200",
      "2026-05-14 08:14:00 +0200",
    );
    expect(a).not.toBe(b);
  });
});
const cumulativeMappings = Object.values(APPLE_HEALTH_TYPE_MAP).filter(
  (mapping) => CUMULATIVE_HK_TYPES.has(mapping.measurementType),
);

function cumulativeExportXml(
  hkIdentifier: string,
  hkUnit: string,
  rows: Array<{ value: number; sourceName: string; hour: number }>,
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
${rows
  .map(
    ({ value, sourceName, hour }) => `  <Record type="${hkIdentifier}"
          unit="${hkUnit}"
          startDate="2026-05-14 ${String(hour).padStart(2, "0")}:00:00 +0200"
          endDate="2026-05-14 ${String(hour).padStart(2, "0")}:30:00 +0200"
          value="${value}"
          sourceName="${sourceName}"
          sourceVersion="1.0"/>`,
  )
  .join("\n")}
</HealthData>`;
}

async function importCumulativeFixture(xml: string) {
  const tmp = mkdtempSync(join(tmpdir(), "healthlog-parser-cumulative-test-"));
  const xmlPath = join(tmp, "export.xml");
  writeFileSync(xmlPath, xml);
  const prisma = makeFakePrisma();
  const result = await streamParseExportXml({
    xmlPath,
    userId: "user-cumulative",
    userTimezone: "Europe/Berlin",
    // The fake implements the importer-facing subset of PrismaClient.
    prisma: prisma as unknown as PrismaClient,
  });
  return { prisma, result };
}

describe("streamParseExportXml — cumulative source-day estimates", () => {
  it("covers exactly the six cumulative HealthKit measurement types", () => {
    expect(CUMULATIVE_HK_TYPES.size).toBe(6);
    expect(
      new Set(cumulativeMappings.map((mapping) => mapping.measurementType)),
    ).toEqual(CUMULATIVE_HK_TYPES);
  });

  it("stores 8,526 rather than source-blind 15,608 for overlapping iPhone and Zepp steps", async () => {
    const { prisma, result } = await importCumulativeFixture(
      cumulativeExportXml("HKQuantityTypeIdentifierStepCount", "count", [
        { value: 8_526, sourceName: "iPhone", hour: 8 },
        { value: 7_082, sourceName: "Zepp", hour: 9 },
      ]),
    );

    expect(prisma._measurements).toHaveLength(1);
    expect(prisma._measurements[0]).toMatchObject({
      value: 8_526,
      aggregationProvenance: "EXPORT_XML_SOURCE_MAX",
      aggregationContributorCount: 2,
    });
    expect(prisma._measurements[0]?.aggregationSelectedSourceHash).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(result.cumulativeEstimates).toEqual({ days: 1, rows: 1 });
  });

  it.each(cumulativeMappings)(
    "selects the largest source-day subtotal for $measurementType",
    async (mapping) => {
      const { prisma } = await importCumulativeFixture(
        cumulativeExportXml(mapping.hkIdentifier, mapping.hkUnit, [
          { value: 30, sourceName: "Source A", hour: 8 },
          { value: 20, sourceName: "Source B", hour: 9 },
        ]),
      );

      expect(prisma._measurements).toHaveLength(1);
      expect(prisma._measurements[0]).toMatchObject({
        type: mapping.measurementType,
        value: 30,
        aggregationProvenance: "EXPORT_XML_SOURCE_MAX",
        aggregationContributorCount: 2,
      });
    },
  );

  it.each(cumulativeMappings)(
    "sums non-overlapping $measurementType rows from the same source",
    async (mapping) => {
      const { prisma } = await importCumulativeFixture(
        cumulativeExportXml(mapping.hkIdentifier, mapping.hkUnit, [
          { value: 30, sourceName: "Source A", hour: 8 },
          { value: 20, sourceName: "Source A", hour: 9 },
        ]),
      );

      expect(prisma._measurements).toHaveLength(1);
      expect(prisma._measurements[0]).toMatchObject({
        type: mapping.measurementType,
        value: 50,
        aggregationContributorCount: 1,
      });
    },
  );
  it("folds unattributed cumulative records into one bounded source bucket", async () => {
    const { prisma } = await importCumulativeFixture(`<?xml version="1.0"?>
<HealthData locale="en_US">
  <Record type="HKQuantityTypeIdentifierStepCount" unit="count"
          startDate="2026-05-14 08:00:00 +0200"
          endDate="2026-05-14 08:30:00 +0200" value="60"/>
  <Record type="HKQuantityTypeIdentifierStepCount" unit="count"
          startDate="2026-05-14 09:00:00 +0200"
          endDate="2026-05-14 09:30:00 +0200" value="40"/>
</HealthData>`);

    expect(prisma._measurements).toHaveLength(1);
    expect(prisma._measurements[0]).toMatchObject({
      value: 100,
      aggregationContributorCount: 1,
    });
  });

  it("rejects a source-day subtotal outside the aggregate range", async () => {
    const { prisma, result } = await importCumulativeFixture(
      cumulativeExportXml("HKQuantityTypeIdentifierStepCount", "count", [
        { value: 150_000, sourceName: "Source A", hour: 8 },
        { value: 150_000, sourceName: "Source A", hour: 9 },
      ]),
    );

    expect(prisma._measurements).toHaveLength(0);
    expect(result.unknown["ACTIVITY_STEPS::aggregate_out_of_range"]).toBe(1);
    expect(result.cumulativeEstimates).toEqual({ days: 0, rows: 0 });
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
describe("streamParseExportXml — statement-level insertion identity", () => {
  it("passes only rows returned by measurement INSERT to arrivals and morning refresh", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "healthlog-parser-test-"));
    const xmlPath = join(tmp, "export.xml");
    writeFileSync(xmlPath, tinyExportXml());
    const weightExternalId = hashSampleKey(
      "HKQuantityTypeIdentifierBodyMass",
      "78.4",
      "2026-05-14 08:13:00 +0200",
      "2026-05-14 08:14:00 +0200",
    );
    const prisma = makeFakePrisma({
      measurementRaceExternalIds: [
        weightExternalId,
        "stats:HKQuantityTypeIdentifierStepCount:2026-05-14",
      ],
    });

    const result = await streamParseExportXml({
      xmlPath,
      userId: "user-1",
      userTimezone: "Europe/Berlin",
      // The fake implements the importer-facing subset of PrismaClient.
      prisma: prisma as unknown as PrismaClient,
      spotBatchSize: 10,
    });

    expect(result.perType.WEIGHT).toMatchObject({ inserted: 0, updated: 1 });
    expect(result.perType.SLEEP_DURATION).toMatchObject({
      inserted: 1,
      updated: 0,
    });
    // The concurrently visible native statistics row is authoritative, so the
    // XML estimate is an intentional no-op.
    expect(result.perType.ACTIVITY_STEPS).toMatchObject({
      inserted: 0,
      updated: 0,
    });

    const arrivalRows = vi.mocked(emitInsertedMeasurementArrivals).mock
      .calls[0]?.[1];
    expect(arrivalRows).toHaveLength(1);
    expect(arrivalRows?.[0]).toMatchObject({ type: "SLEEP_DURATION" });
    expect(maybeEnqueueMorningRefresh).toHaveBeenCalledWith("user-1", [
      arrivalRows?.[0]?.measuredAt,
    ]);
  });

  it("emits only the workout returned by a short batched INSERT result", async () => {
    const first = {
      activity: "HKWorkoutActivityTypeRunning",
      duration: "30.0",
      start: "2026-05-14 08:00:00 +0200",
      end: "2026-05-14 08:30:00 +0200",
    };
    const second = {
      activity: "HKWorkoutActivityTypeCycling",
      duration: "45.0",
      start: "2026-05-14 10:00:00 +0200",
      end: "2026-05-14 10:45:00 +0200",
    };
    const xmlPath = join(
      mkdtempSync(join(tmpdir(), "healthlog-parser-test-")),
      "export.xml",
    );
    writeFileSync(
      xmlPath,
      `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
  <Workout workoutActivityType="${first.activity}" duration="${first.duration}" durationUnit="min" startDate="${first.start}" endDate="${first.end}"/>
  <Workout workoutActivityType="${second.activity}" duration="${second.duration}" durationUnit="min" startDate="${second.start}" endDate="${second.end}"/>
</HealthData>`,
    );
    const racedExternalId = hashSampleKey(
      first.activity,
      first.duration,
      first.start,
      first.end,
    );
    const insertedExternalId = hashSampleKey(
      second.activity,
      second.duration,
      second.start,
      second.end,
    );
    const prisma = makeFakePrisma({
      workoutRaceExternalIds: [racedExternalId],
    });

    const result = await streamParseExportXml({
      xmlPath,
      userId: "user-1",
      userTimezone: "Europe/Berlin",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: prisma as any,
      workoutBatchSize: 2,
    });

    expect(result.workouts).toMatchObject({ inserted: 1, updated: 1 });
    const insertedWorkout = prisma._workouts.find(
      (row) => row.externalId === insertedExternalId,
    );
    expect(emitDataArrival).toHaveBeenCalledTimes(1);
    expect(emitDataArrival).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        kind: "workout",
        refId: insertedWorkout?.id,
        insertedCount: 1,
        source: "apple_export",
      }),
    );
  });
  it("emits arrivals for committed batches before a later batch fails", async () => {
    const xmlPath = join(
      mkdtempSync(join(tmpdir(), "healthlog-parser-test-")),
      "export.xml",
    );
    writeFileSync(
      xmlPath,
      `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
  <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="30.0" durationUnit="min" startDate="2026-05-14 08:00:00 +0200" endDate="2026-05-14 08:30:00 +0200"/>
${" ".repeat(70_000)}
  <Workout workoutActivityType="HKWorkoutActivityTypeCycling" duration="45.0" durationUnit="min" startDate="2026-05-14 10:00:00 +0200" endDate="2026-05-14 10:45:00 +0200"/>
</HealthData>`,
    );
    const prisma = makeFakePrisma();
    const createManyAndReturn = prisma.workout.createManyAndReturn;
    let flushCount = 0;
    prisma.workout.createManyAndReturn = async (args) => {
      flushCount += 1;
      if (flushCount === 2) throw new Error("later batch failed");
      return createManyAndReturn(args);
    };

    await expect(
      streamParseExportXml({
        xmlPath,
        userId: "user-1",
        userTimezone: "Europe/Berlin",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        prisma: prisma as any,
        workoutBatchSize: 1,
      }),
    ).rejects.toThrow("later batch failed");

    expect(emitDataArrival).toHaveBeenCalledTimes(1);
    expect(emitDataArrival).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        kind: "workout",
        insertedCount: 1,
        source: "apple_export",
      }),
    );
  });
});

/**
 * Issue #486 — two Apple samples that share the `measurements` natural key
 * `(userId, type, measuredAt, source, sleepStage)` but carry DIFFERENT
 * externalIds. The externalId upsert misses on the second → its create leg
 * collides on the natural key → P2002. Before the natural-key rescue this
 * aborted the whole import after minutes of work; after it, the run completes
 * with the colliding row adopted in place.
 */
describe("streamParseExportXml — natural-key collision (issue #486)", () => {
  // Both records share `endDate` (→ same `measuredAt`, the natural key) but
  // differ in `startDate`/`value` (→ different `hashSampleKey` externalId).
  function collidingExportXml(): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE HealthData [<!ELEMENT HealthData (Record)*>]>
<HealthData locale="en_US">
  <Record type="HKQuantityTypeIdentifierBodyMass"
          unit="kg"
          startDate="2026-05-14 08:10:00 +0200"
          endDate="2026-05-14 08:14:00 +0200"
          value="78.4"
          sourceName="Source App A"/>
  <Record type="HKQuantityTypeIdentifierBodyMass"
          unit="kg"
          startDate="2026-05-14 08:12:00 +0200"
          endDate="2026-05-14 08:14:00 +0200"
          value="78.6"
          sourceName="Source App B"/>
</HealthData>`;
  }

  it("completes and adopts the colliding row instead of throwing P2002", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "healthlog-parser-test-"));
    const xmlPath = join(tmp, "export.xml");
    writeFileSync(xmlPath, collidingExportXml());
    const prisma = makeFakePrisma();

    // On pre-fix code this rejects with the P2002 the fake raises when the
    // second create hits the natural key; on fixed code it resolves.
    const result = await streamParseExportXml({
      xmlPath,
      userId: "user-1",
      userTimezone: "Europe/Berlin",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: prisma as any,
    });

    // Both samples were read; one row physically landed, the twin adopted it.
    expect(result.perType.WEIGHT?.read).toBe(2);
    expect(result.perType.WEIGHT?.inserted).toBe(1);
    expect(result.perType.WEIGHT?.updated).toBe(1);

    const weightRows = prisma._measurements.filter((m) => m.type === "WEIGHT");
    expect(weightRows).toHaveLength(1);
    // Last write wins: value + externalId re-keyed onto the second sample.
    expect(weightRows[0]?.value).toBe(78.6);
    const secondExternalId = hashSampleKey(
      "HKQuantityTypeIdentifierBodyMass",
      "78.6",
      "2026-05-14 08:12:00 +0200",
      "2026-05-14 08:14:00 +0200",
    );
    expect(weightRows[0]?.externalId).toBe(secondExternalId);

    // The collision was rescued, not skipped.
    expect(result.unknown["WEIGHT::natural_key_unresolved"]).toBeUndefined();
    expect(result.unknown["WEIGHT::natural_key_rescue_failed"]).toBeUndefined();
  });

  it("re-import of overlapping data with a re-keyed externalId adopts the prior row", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "healthlog-parser-test-"));
    const prisma = makeFakePrisma();

    // First import: single reading, externalId derived from its start/end.
    const firstPath = join(tmp, "export-1.xml");
    writeFileSync(
      firstPath,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE HealthData [<!ELEMENT HealthData (Record)*>]>
<HealthData locale="en_US">
  <Record type="HKQuantityTypeIdentifierBodyMass"
          unit="kg"
          startDate="2026-05-14 08:10:00 +0200"
          endDate="2026-05-14 08:14:00 +0200"
          value="78.4"/>
</HealthData>`,
    );
    const first = await streamParseExportXml({
      xmlPath: firstPath,
      userId: "user-1",
      userTimezone: "Europe/Berlin",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: prisma as any,
    });
    expect(first.perType.WEIGHT?.inserted).toBe(1);
    expect(prisma._measurements).toHaveLength(1);

    // Re-export: SAME instant (endDate), but the sample now carries a
    // different start window → a re-keyed externalId. The externalId upsert
    // misses; the natural key is still held by the first row.
    const secondPath = join(tmp, "export-2.xml");
    writeFileSync(
      secondPath,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE HealthData [<!ELEMENT HealthData (Record)*>]>
<HealthData locale="en_US">
  <Record type="HKQuantityTypeIdentifierBodyMass"
          unit="kg"
          startDate="2026-05-14 08:11:30 +0200"
          endDate="2026-05-14 08:14:00 +0200"
          value="79.0"/>
</HealthData>`,
    );
    const second = await streamParseExportXml({
      xmlPath: secondPath,
      userId: "user-1",
      userTimezone: "Europe/Berlin",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: prisma as any,
    });

    // No duplicate row; the prior row was adopted, counted as an update.
    expect(second.perType.WEIGHT?.inserted).toBe(0);
    expect(second.perType.WEIGHT?.updated).toBe(1);
    expect(prisma._measurements).toHaveLength(1);
    expect(prisma._measurements[0]?.value).toBe(79.0);
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
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<!DOCTYPE HealthData [<!ELEMENT HealthData (Record)*>]>\n` +
      `<HealthData locale="en_US">\n`;
    const footer = `</HealthData>\n`;
    const rows: string[] = [];
    for (let i = 0; i < 10_000; i++) {
      const hour = Math.floor(i / 3600) % 24;
      const minute = Math.floor((i % 3600) / 60);
      const second = i % 60;
      const ts = `2026-05-14 ${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}:${second.toString().padStart(2, "0")} +0200`;
      rows.push(
        `<Record type="HKQuantityTypeIdentifierStepCount"` +
          ` unit="count"` +
          ` startDate="${ts}"` +
          ` endDate="${ts}"` +
          ` value="1"/>\n`,
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
    expect(prisma._measurements).toHaveLength(1);
    expect(prisma._measurements[0]).toMatchObject({
      value: 10_000,
      aggregationContributorCount: 1,
    });

    // Heap delta should be modest — we tolerate a generous 100 MB so a
    // GC-related spike doesn't flake the test, but a regression that
    // buffers per-record would push us above this ceiling fast.
    expect(heapDelta).toBeLessThan(100 * 1024 * 1024);
  });
});
