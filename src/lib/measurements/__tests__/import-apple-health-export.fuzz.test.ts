/**
 * The Apple Health `export.xml` parser against generated documents.
 *
 * The documents are built from the elements and attributes the parser reads
 * (records of every mapped type, workouts with their children, clinical
 * records, metadata), with values drawn from what a broken or hostile file
 * might put there, plus raw mutations of a valid export and entity tricks in
 * the DOCTYPE. For each one the parse either finishes with a result whose
 * counts add up, or stops with the XML reader's own syntax error. A
 * `TypeError` or `RangeError` from a tag handler, an invalid date in a row,
 * or a run that takes seconds on a few kilobytes fails the property.
 *
 * The database is an empty stand-in: every read finds nothing and every
 * write succeeds, which is the path a first import takes.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";

import fc from "fast-check";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/arrivals/measurement-emit", () => ({
  emitInsertedMeasurementArrivals: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/daily/morning-refresh-trigger", () => ({
  maybeEnqueueMorningRefresh: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/arrivals/emit-shared", () => ({
  emitDataArrival: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/cycle/gate", () => ({
  isCycleAvailableForUser: vi.fn(async () => true),
}));
vi.mock("@/lib/export/measurement-bulk-insert", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/export/measurement-bulk-insert")
  >()),
  insertNewMeasurementRows: vi.fn(async () => []),
}));

import type { PrismaClient } from "@/generated/prisma/client";

import { extractExportXml } from "@/lib/import/unzip-export-xml";

import { APPLE_HEALTH_TYPE_MAP } from "../apple-health-mapping";
import { streamParseExportXml } from "../import-apple-health-export";

import {
  assertAsyncProperty,
  propertyTimeout,
} from "../../../../tests/property/fast-check";

const DIR = mkdtempSync(join(tmpdir(), "ah-xml-fuzz-"));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

/** A database with nothing in it, that accepts every write. */
function emptyDb(): PrismaClient {
  const model = new Proxy(
    {},
    {
      get: (_t, op) => async () => {
        if (
          op === "findMany" ||
          op === "createManyAndReturn" ||
          op === "groupBy"
        )
          return [];
        if (op === "count") return 0;
        if (op === "findFirst" || op === "findUnique") return null;
        if (op === "createMany" || op === "updateMany" || op === "deleteMany") {
          return { count: 0 };
        }
        return {};
      },
    },
  );
  const db: Record<string | symbol, unknown> = new Proxy(
    {},
    {
      get: (_t, key) => {
        if (key === "then") return undefined;
        if (key === "$transaction") {
          return async (arg: unknown) =>
            typeof arg === "function" ? arg(db) : Promise.all(arg as unknown[]);
        }
        if (typeof key === "string" && key.startsWith("$"))
          return async () => [];
        return model;
      },
    },
  );
  return db as unknown as PrismaClient;
}

const xmlEscape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

const date = fc.oneof(
  fc.constantFrom(
    "2026-05-14 08:13:00 +0200",
    "2026-05-14 08:13:00 -0000",
    "2026-02-30 25:61:61 +0200",
    "1899-12-31 23:59:59 +0000",
    "9999-12-31 23:59:59 +1400",
    "2026-05-14T08:13:00Z",
    "",
    "yesterday",
  ),
  fc
    .date({
      min: new Date("1990-01-01"),
      max: new Date("2030-01-01"),
      noInvalidDate: true,
    })
    .map((d) => `${d.toISOString().slice(0, 19).replace("T", " ")} +0000`),
);
const number = fc.oneof(
  fc.constantFrom(
    "0",
    "-1",
    "1e309",
    "-1e309",
    "NaN",
    "Infinity",
    "0x1F",
    "1,5",
    " 72 ",
    "",
    "9".repeat(400),
  ),
  fc.double({ noNaN: false }).map(String),
);
const text = fc.string({ maxLength: 60 });
const recordType = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.constantFrom(...Object.keys(APPLE_HEALTH_TYPE_MAP)),
  },
  {
    weight: 1,
    arbitrary: fc.constantFrom(
      "HKCategoryTypeIdentifierSleepAnalysis",
      "HKCategoryTypeIdentifierMenstrualFlow",
      "HKQuantityTypeIdentifierStepCount",
      "HKCorrelationTypeIdentifierBloodPressure",
      "HKDataTypeSleepDurationGoal",
      "HKQuantityTypeIdentifierFutureType",
    ),
  },
  { weight: 1, arbitrary: text },
);

function attrs(values: Record<string, string | undefined>): string {
  return Object.entries(values)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => ` ${k}="${xmlEscape(v!)}"`)
    .join("");
}

const metadata = fc
  .array(
    fc.tuple(
      fc.constantFrom(
        "HKMetadataKeyHeartRateMotionContext",
        "HKWasUserEntered",
        "HKExternalUUID",
        "HealthLogId",
        "HKTimeZone",
      ),
      text,
    ),
    { maxLength: 3 },
  )
  .map((es) =>
    es
      .map(([k, v]) => `<MetadataEntry${attrs({ key: k, value: v })}/>`)
      .join(""),
  );

const record = fc
  .record({
    type: recordType,
    unit: fc.oneof(
      fc.constantFrom(
        "kg",
        "lb",
        "count",
        "count/min",
        "mmHg",
        "%",
        "mg/dL",
        "mmol<180.1558800000541>/L",
        "degC",
        "ms",
        "",
      ),
      text,
    ),
    value: fc.oneof(
      number,
      fc.constantFrom(
        "HKCategoryValueSleepAnalysisAsleepDeep",
        "HKCategoryValueSleepAnalysisInBed",
        "HKCategoryValueMenstrualFlowHeavy",
      ),
    ),
    startDate: date,
    endDate: date,
    sourceName: fc.oneof(text, fc.constantFrom("HealthLog", "Apple Watch")),
    sourceVersion: fc.option(text, { nil: undefined }),
    meta: metadata,
  })
  .map(({ meta, ...a }) => `<Record${attrs(a)}>${meta}</Record>`);

const workout = fc
  .record({
    workoutActivityType: fc.oneof(
      fc.constantFrom(
        "HKWorkoutActivityTypeRunning",
        "HKWorkoutActivityTypeCycling",
        "HKWorkoutActivityTypeOther",
      ),
      text,
    ),
    duration: number,
    durationUnit: fc.constantFrom("min", "s", "h", ""),
    totalDistance: fc.option(number, { nil: undefined }),
    totalDistanceUnit: fc.option(fc.constantFrom("km", "mi", "m"), {
      nil: undefined,
    }),
    totalEnergyBurned: fc.option(number, { nil: undefined }),
    totalEnergyBurnedUnit: fc.option(fc.constantFrom("kcal", "kJ"), {
      nil: undefined,
    }),
    startDate: date,
    endDate: date,
    sourceName: text,
    stats: fc.array(
      fc.record({
        type: recordType,
        startDate: date,
        endDate: date,
        average: fc.option(number, { nil: undefined }),
        sum: fc.option(number, { nil: undefined }),
        unit: fc.constantFrom("count/min", "km", "kcal"),
      }),
      { maxLength: 3 },
    ),
    events: fc.array(
      fc.record({
        type: fc.constantFrom(
          "HKWorkoutEventTypePause",
          "HKWorkoutEventTypeResume",
          "HKWorkoutEventTypeLap",
        ),
        date,
        duration: number,
      }),
      { maxLength: 3 },
    ),
    route: fc.option(
      fc.constantFrom(
        "/workout-routes/route_2026-05-14_6.00pm.gpx",
        "../../etc/passwd",
        "",
      ),
      { nil: undefined },
    ),
  })
  .map(({ stats, events, route, ...a }) =>
    [
      `<Workout${attrs(a)}>`,
      ...events.map((e) => `<WorkoutEvent${attrs(e)}/>`),
      ...stats.map((s) => `<WorkoutStatistics${attrs(s)}/>`),
      route === undefined
        ? ""
        : `<WorkoutRoute><FileReference${attrs({ path: route })}/></WorkoutRoute>`,
      `</Workout>`,
    ].join(""),
  );

const clinical = fc
  .record({
    type: fc.constantFrom(
      "HKClinicalTypeIdentifierLabResultRecord",
      "HKClinicalTypeIdentifierConditionRecord",
      "x",
    ),
    identifier: text,
    resourceFilePath: fc.constantFrom(
      "/clinical-records/Observation-1.json",
      "/../x.json",
      "",
    ),
    fhirResource: fc.oneof(text, fc.constant("{}")),
  })
  .map((a) => `<ClinicalRecord${attrs(a)}/>`);

const prologue = fc.constantFrom(
  "",
  '<?xml version="1.0" encoding="UTF-8"?>\n',
  '<?xml version="1.0"?>\n<!DOCTYPE HealthData [<!ELEMENT HealthData ANY>]>\n',
  // External and recursive entities: the parser must neither fetch the one
  // nor expand the other.
  '<?xml version="1.0"?>\n<!DOCTYPE HealthData [<!ENTITY xxe SYSTEM "file:///etc/passwd"><!ENTITY a "&a;&a;">]>\n',
);

const document = fc
  .tuple(
    prologue,
    fc.option(date, { nil: undefined }),
    fc.array(
      fc.oneof(
        { weight: 6, arbitrary: record },
        { weight: 2, arbitrary: workout },
        { weight: 1, arbitrary: clinical },
        {
          weight: 1,
          arbitrary: fc.constantFrom(
            "&xxe;",
            "&a;",
            "&#0;",
            "&#x110000;",
            "<![CDATA[x]]>",
            "<Me/>",
            "<!-- c -->",
          ),
        },
      ),
      { maxLength: 25 },
    ),
  )
  .map(
    ([head, exportDate, body]) =>
      `${head}<HealthData locale="en_US">${exportDate === undefined ? "" : `<ExportDate${attrs({ value: exportDate })}/>`}${body.join("")}</HealthData>`,
  );

/** A valid document with byte ranges overwritten or cut off. */
const mutated = fc
  .tuple(
    document,
    fc.array(
      fc.tuple(
        fc.nat(),
        fc.constantFrom("<", ">", '"', "/", "&", "\u0000", "�", " ", "="),
      ),
      { minLength: 1, maxLength: 6 },
    ),
    fc.option(fc.nat(), { nil: undefined }),
  )
  .map(([doc, edits, cut]) => {
    const chars = [...doc];
    for (const [at, ch] of edits) chars[at % chars.length] = ch;
    const out = chars.join("");
    return cut === undefined ? out : out.slice(0, cut % (out.length + 1));
  });

let n = 0;
async function parse(xml: string) {
  const xmlPath = join(DIR, `export-${n++}.xml`);
  writeFileSync(xmlPath, xml);
  try {
    return await streamParseExportXml({
      xmlPath,
      userId: "user-1",
      userTimezone: "Europe/Berlin",
      prisma: emptyDb(),
      spotBatchSize: 7,
      workoutBatchSize: 3,
      onWorkoutRoute: () => {},
      onClinicalLabRecord: () => {},
    });
  } finally {
    rmSync(xmlPath, { force: true });
  }
}

/** The error the XML reader raises for a syntax problem, with its position. */
function isSyntaxError(err: unknown): boolean {
  return err instanceof Error && /\nLine: \d+\nColumn: \d+/.test(err.message);
}

describe("streamParseExportXml on generated documents", () => {
  it(
    "finishes with a consistent result or stops at an XML syntax error",
    async () => {
      await assertAsyncProperty(
        fc.asyncProperty(fc.oneof(document, mutated), async (xml) => {
          const started = performance.now();
          let result;
          try {
            result = await parse(xml);
          } catch (err) {
            if (!isSyntaxError(err)) throw err;
            return;
          }
          expect(performance.now() - started).toBeLessThan(2_000);
          expect(result.totals.recordsRead).toBeGreaterThanOrEqual(0);
          if (result.measuredSpan) {
            const from = Date.parse(result.measuredSpan.from);
            const to = Date.parse(result.measuredSpan.to);
            expect(Number.isNaN(from) || Number.isNaN(to)).toBe(false);
            expect(from).toBeLessThanOrEqual(to);
          }
        }),
        250,
      );
    },
    propertyTimeout(120_000),
  );
});

/** A one-member ZIP the way the Health app writes a small export. */
function zipOf(name: string, payload: Buffer): Buffer {
  const data = deflateRawSync(payload);
  const crc = crc32(payload);
  const file = Buffer.from(name, "utf8");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(payload.length, 22);
  local.writeUInt16LE(file.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(payload.length, 24);
  central.writeUInt16LE(file.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + file.length, 12);
  end.writeUInt32LE(30 + file.length + data.length, 16);
  return Buffer.concat([local, file, data, central, file, end]);
}

describe("extractExportXml on damaged archives", () => {
  const ARCHIVE = zipOf(
    "apple_health_export/export.xml",
    Buffer.from(
      '<?xml version="1.0"?><HealthData><Record type="HKQuantityTypeIdentifierBodyMass" unit="kg" value="72" startDate="2026-05-14 08:00:00 +0200" endDate="2026-05-14 08:00:00 +0200"/></HealthData>'.repeat(
        4,
      ),
    ),
  );

  it("extracts or refuses with its own error, never a bounds or type error", async () => {
    await assertAsyncProperty(
      fc.asyncProperty(
        fc.array(fc.tuple(fc.nat(), fc.integer({ min: 0, max: 255 })), {
          minLength: 1,
          maxLength: 10,
        }),
        fc.option(fc.nat(), { nil: undefined }),
        async (edits, cut) => {
          let bytes = Buffer.from(ARCHIVE);
          for (const [at, value] of edits) bytes[at % bytes.length] = value;
          if (cut !== undefined)
            bytes = bytes.subarray(0, cut % (bytes.length + 1));
          const path = join(DIR, `export-${n++}.zip`);
          writeFileSync(path, bytes);
          try {
            const out = await extractExportXml(path);
            rmSync(out.xmlPath, { force: true });
          } catch (err) {
            expect(err).toBeInstanceOf(Error);
            expect(err).not.toBeInstanceOf(TypeError);
            expect(err).not.toBeInstanceOf(RangeError);
          } finally {
            rmSync(path, { force: true });
          }
        },
      ),
      300,
    );
  });
});

describe("streamParseExportXml regressions the properties found", () => {
  it("skips a reproductive sample with an unreadable date instead of ending the import", async () => {
    const result = await parse(
      `<HealthData><Record type="HKCategoryTypeIdentifierMenstrualFlow" value="HKCategoryValueMenstrualFlowHeavy" startDate="2026-05-14 08:00:00 +0200" endDate="2026-05-14 0&lt;:13:00 +0200"/><Record type="HKQuantityTypeIdentifierBodyMass" unit="kg" value="72" startDate="2026-05-14 08:00:00 +0200" endDate="2026-05-14 08:00:00 +0200" sourceName="Scale"/></HealthData>`,
    );
    expect(result.totals.recordsRead).toBe(2);
    expect(
      result.unknown["HKCategoryTypeIdentifierMenstrualFlow::unparseable"],
    ).toBe(1);
  });
});
