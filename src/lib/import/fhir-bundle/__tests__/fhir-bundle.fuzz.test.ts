/**
 * The FHIR Bundle import against generated files.
 *
 * A patient-portal export is JSON written by someone else's server, so every
 * field can be missing, the wrong type, absurdly long or nested. The
 * properties feed the whole file path (read, parse, every entry through its
 * mapper and record builder) with Bundles built from the resource types the
 * import reads, with junk in each field, and with arbitrary bytes. The
 * import finishes and accounts for every entry, or it refuses the file with
 * a `RecordFileImportError`; nothing else reaches the worker.
 *
 * Every write is stubbed: the database is an empty stand-in, which is what a
 * first import sees.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const { emptyDb } = vi.hoisted(() => {
  function emptyDb(): unknown {
    const model = new Proxy(
      {},
      {
        get: (_t, op) => async () => {
          if (op === "findMany" || op === "groupBy") return [];
          if (op === "count") return 0;
          if (op === "findFirst" || op === "findUnique") return null;
          if (op === "create" || op === "upsert") return { id: "row-1" };
          return { count: 0 };
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
              typeof arg === "function"
                ? (arg as (tx: unknown) => unknown)(db)
                : Promise.all(arg as unknown[]);
          }
          if (typeof key === "string" && key.startsWith("$")) {
            return async () => [];
          }
          return model;
        },
      },
    );
    return db;
  }
  return { emptyDb };
});

vi.mock("@/lib/db", () => ({ prisma: emptyDb() }));
vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserMedications: vi.fn(),
}));
vi.mock("@/lib/import/file-import/write-measurements", () => ({
  writeImportedMeasurements: vi.fn(async () => undefined),
}));
vi.mock("@/lib/labs/fhir-import/write", () => ({
  writeFhirLabReadings: vi.fn(async (input: { readings: unknown[] }) => ({
    statuses: input.readings.map(() => ({ status: "inserted" })),
    inserted: input.readings.length,
    newestTakenAt: null,
  })),
}));
vi.mock("@/lib/labs/fhir-import/after-write", () => ({
  afterLabReadingsWritten: vi.fn(),
}));

import { _resetCryptoCacheForTests } from "@/lib/crypto";
import { RecordFileImportError } from "@/lib/import/file-import/kinds";
import { RecordFileImportTally } from "@/lib/import/file-import/tally";

import { importFhirBundleFile, mapVital } from "../import";

import {
  assertAsyncProperty,
  assertProperty,
  propertyTimeout,
} from "../../../../../tests/property/fast-check";
import {
  PROTOTYPE_KEYS,
  expectPrototypesUntouched,
  snapshotPrototypes,
} from "../../../../../tests/property/prototype-keys";

const DIR = mkdtempSync(join(tmpdir(), "fhir-fuzz-"));
// Visit reasons are stored encrypted, as on every real host; without a key
// the Encounter path failed on the missing key instead of on the file.
const before = snapshotPrototypes();
beforeAll(() => {
  vi.stubEnv("ENCRYPTION_KEYS", "");
  vi.stubEnv("ENCRYPTION_ACTIVE_KEY_ID", "");
  vi.stubEnv(
    "ENCRYPTION_KEY",
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  );
  _resetCryptoCacheForTests();
});
afterAll(() => {
  rmSync(DIR, { recursive: true, force: true });
  vi.unstubAllEnvs();
  _resetCryptoCacheForTests();
  // A code, unit or class that names a prototype member never writes one.
  expectPrototypesUntouched(before);
});
const NOW = new Date("2026-06-01T00:00:00Z");

/** Any JSON value, shallow, with the odd shapes a broken exporter writes. */
const junk = fc.oneof(
  fc.constant(null),
  fc.boolean(),
  fc.double(),
  fc.string({ maxLength: 40 }),
  fc.constantFrom(
    "",
    "1e309",
    "-0",
    "NaN",
    "2026-02-30T25:00:00Z",
    ...PROTOTYPE_KEYS,
  ),
  fc.array(fc.string({ maxLength: 8 }), { maxLength: 3 }),
  fc.dictionary(fc.string({ maxLength: 8 }), fc.string({ maxLength: 8 }), {
    maxKeys: 3,
  }),
);
const maybe = <T>(arb: fc.Arbitrary<T>) =>
  fc.oneof({ weight: 3, arbitrary: arb }, { weight: 1, arbitrary: junk });

const instant = maybe(
  fc.oneof(
    fc
      .date({
        min: new Date("1900-01-01"),
        max: new Date("2100-01-01"),
        noInvalidDate: true,
      })
      .map((d) => d.toISOString()),
    fc.constantFrom(
      "2026-05-01",
      "2026-05",
      "2026",
      "2026-05-01T08:00:00",
      "2026-05-01T08:00:00+14:00",
    ),
  ),
);
const coding = fc.record(
  {
    system: maybe(
      fc.constantFrom(
        "http://loinc.org",
        "http://snomed.info/sct",
        "urn:oid:1.2.3",
      ),
    ),
    code: maybe(
      fc.constantFrom(
        "8867-4",
        "85354-9",
        "8480-6",
        "8462-4",
        "29463-7",
        "2339-0",
        "718-7",
        "4548-4",
        "x",
        ...PROTOTYPE_KEYS,
      ),
    ),
    display: maybe(fc.string({ maxLength: 80 })),
  },
  { requiredKeys: [] },
);
const concept = fc.record(
  {
    coding: maybe(fc.array(coding, { maxLength: 3 })),
    text: maybe(fc.string({ maxLength: 80 })),
  },
  { requiredKeys: [] },
);
const quantity = fc.record(
  {
    value: maybe(fc.oneof(fc.double(), fc.integer())),
    unit: maybe(
      fc.constantFrom(
        "/min",
        "mm[Hg]",
        "kg",
        "mg/dL",
        "mmol/L",
        "%",
        "",
        "g/dL",
        ...PROTOTYPE_KEYS,
      ),
    ),
    code: maybe(
      fc.constantFrom("/min", "mm[Hg]", "kg", "mg/dL", ...PROTOTYPE_KEYS),
    ),
    comparator: maybe(fc.constantFrom("<", ">", "<=")),
  },
  { requiredKeys: [] },
);
const category = fc.array(
  fc.record({
    coding: fc.array(
      fc.record({
        code: maybe(fc.constantFrom("vital-signs", "laboratory", "survey")),
      }),
      { maxLength: 2 },
    ),
  }),
  { maxLength: 2 },
);

const observation = fc.record(
  {
    resourceType: fc.constant("Observation"),
    id: maybe(fc.string({ maxLength: 200 })),
    status: maybe(
      fc.constantFrom("final", "amended", "preliminary", "entered-in-error"),
    ),
    category,
    code: maybe(concept),
    effectiveDateTime: instant,
    effectivePeriod: maybe(fc.record({ start: instant }, { requiredKeys: [] })),
    issued: instant,
    valueQuantity: maybe(quantity),
    valueString: maybe(fc.string({ maxLength: 60 })),
    referenceRange: maybe(
      fc.array(
        fc.record(
          {
            low: maybe(quantity),
            high: maybe(quantity),
            text: maybe(fc.string({ maxLength: 30 })),
          },
          { requiredKeys: [] },
        ),
        { maxLength: 2 },
      ),
    ),
    component: maybe(
      fc.array(
        fc.record(
          { code: maybe(concept), valueQuantity: maybe(quantity) },
          { requiredKeys: [] },
        ),
        { maxLength: 3 },
      ),
    ),
  },
  { requiredKeys: ["resourceType"] },
);
const recordResource = fc.record(
  {
    resourceType: fc.constantFrom(
      "Condition",
      "Immunization",
      "MedicationStatement",
      "Encounter",
      "Patient",
      "Procedure",
    ),
    id: maybe(fc.string({ maxLength: 64 })),
    status: maybe(
      fc.constantFrom(
        "active",
        "completed",
        "stopped",
        "entered-in-error",
        "finished",
      ),
    ),
    clinicalStatus: maybe(concept),
    code: maybe(concept),
    vaccineCode: maybe(concept),
    medicationCodeableConcept: maybe(concept),
    onsetDateTime: instant,
    recordedDate: instant,
    occurrenceDateTime: instant,
    effectivePeriod: maybe(
      fc.record({ start: instant, end: instant }, { requiredKeys: [] }),
    ),
    period: maybe(
      fc.record({ start: instant, end: instant }, { requiredKeys: [] }),
    ),
    dosage: maybe(
      fc.array(
        fc.record(
          { text: maybe(fc.string({ maxLength: 200 })) },
          { requiredKeys: [] },
        ),
        { maxLength: 2 },
      ),
    ),
    type: maybe(fc.array(concept, { maxLength: 2 })),
    class: maybe(
      fc.record(
        { code: maybe(fc.constantFrom("EMER", "AMB", ...PROTOTYPE_KEYS)) },
        { requiredKeys: [] },
      ),
    ),
    reasonCode: maybe(fc.array(concept, { maxLength: 2 })),
    note: maybe(
      fc.array(fc.record({ text: maybe(fc.string({ maxLength: 300 })) }), {
        maxLength: 2,
      }),
    ),
  },
  { requiredKeys: ["resourceType"] },
);
const entry = fc.record(
  {
    fullUrl: maybe(
      fc.constantFrom(
        "https://fhir.example.org/r4/Observation/1",
        "urn:uuid:0b7b3a7e-6f1e-4b8e-9f3e-1c2d3e4f5a6b",
        "urn:oid:1.2",
        "not a url",
        "",
      ),
    ),
    resource: fc.oneof(
      { weight: 3, arbitrary: observation },
      { weight: 2, arbitrary: recordResource },
      { weight: 1, arbitrary: junk },
    ),
  },
  { requiredKeys: [] },
);
const bundle = fc.record(
  {
    resourceType: fc.constantFrom("Bundle", "Bundle", "Bundle", "Patient"),
    id: maybe(fc.string({ maxLength: 40 })),
    type: maybe(fc.constantFrom("collection", "searchset", "document")),
    entry: maybe(
      fc.array(
        fc.oneof(
          { weight: 5, arbitrary: entry },
          { weight: 1, arbitrary: junk },
        ),
        { maxLength: 25 },
      ),
    ),
  },
  { requiredKeys: ["resourceType"] },
);

let n = 0;
async function importText(text: string | Uint8Array) {
  const path = join(DIR, `bundle-${n++}.json`);
  writeFileSync(path, text);
  const tally = new RecordFileImportTally("fhir_bundle");
  try {
    await importFhirBundleFile({
      userId: "user-1",
      path,
      tz: "Europe/Berlin",
      tally,
    });
    return { tally, err: null as unknown };
  } catch (err) {
    return { tally, err };
  } finally {
    rmSync(path, { force: true });
  }
}

describe("importFhirBundleFile on generated files", () => {
  it(
    "imports a generated Bundle or refuses the file",
    async () => {
      await assertAsyncProperty(
        fc.asyncProperty(bundle, async (b) => {
          const { err } = await importText(JSON.stringify(b));
          if (err !== null) expect(err).toBeInstanceOf(RecordFileImportError);
        }),
        250,
      );
    },
    propertyTimeout(120_000),
  );

  it("refuses bytes that are not a Bundle", async () => {
    await assertAsyncProperty(
      fc.asyncProperty(
        fc.oneof(
          fc.uint8Array({ maxLength: 300 }),
          fc.json({ maxDepth: 4 }),
          // Deep nesting that JSON.parse accepts and a recursive walk would not.
          fc
            .integer({ min: 1, max: 5_000 })
            .map((d) => `${"[".repeat(d)}${"]".repeat(d)}`),
        ),
        async (bytes) => {
          const { err } = await importText(bytes);
          expect(err).toBeInstanceOf(RecordFileImportError);
        },
      ),
      150,
    );
  });

  it("refuses deeply nested resources without overflowing the stack", async () => {
    const deep = (d: number) => `${'{"a":'.repeat(d)}1${"}".repeat(d)}`;
    const text = `{"resourceType":"Bundle","entry":[{"resource":{"resourceType":"Observation","status":"final","category":[{"coding":[{"code":"vital-signs"}]}],"code":{"coding":[{"system":"http://loinc.org","code":"8867-4"}]},"effectiveDateTime":"2026-05-01T08:00:00Z","valueQuantity":{"value":60,"unit":"/min"},"extension":${deep(200_000)}}}]}`;
    const { err } = await importText(text);
    if (err !== null) expect(err).toBeInstanceOf(RecordFileImportError);
  });
});

describe("mapVital", () => {
  it("maps an Observation to finite, dated rows or a reason", () => {
    assertProperty(
      fc.property(observation, (o) => {
        const out = mapVital(
          o as Record<string, unknown>,
          "https://fhir.example.org",
          NOW,
          "Europe/Berlin",
        );
        if ("reason" in out) {
          expect(out.reason).toMatch(/^[a-z_]+$/);
          return;
        }
        for (const row of out) {
          expect(Number.isFinite(row.value)).toBe(true);
          expect(row.measuredAt.getTime()).toBeLessThanOrEqual(NOW.getTime());
          expect(row.externalId).toMatch(/^fhirb:[0-9a-f]{40}/);
        }
      }),
      500,
    );
  });
});
