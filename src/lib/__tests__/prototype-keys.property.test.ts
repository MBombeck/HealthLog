/**
 * Every reader of outside text, fed the names a plain object answers for.
 *
 * Codes, units, headers, member names and preference keys come from files,
 * request bodies, stored JSON and third-party payloads. Each property feeds
 * `"__proto__"`, `"constructor"`, `"prototype"` and the other inherited names
 * (`tests/property/prototype-keys.ts`) where a parser looks something up or
 * builds a map, and asserts the same three things: the parser answers
 * instead of throwing, the name is treated as unknown or as an ordinary
 * entry, and the shared prototypes carry nothing new afterwards.
 *
 * The rule these hold up is in `src/lib/own-key.ts`; the structural half is
 * `src/__tests__/prototype-key-guard.test.ts`. The parsers that need a file
 * or a database have their own case beside their other tests (Health
 * Connect in its integration suite, multipart and profile updates in theirs,
 * the FHIR vitals in `fhir-bundle/__tests__/vitals.test.ts`).
 */
import { Readable } from "node:stream";

import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseAppleHealthEcgCsv } from "@/lib/apple-health/ecg-csv";
import { mapHkCycleSample } from "@/lib/cycle/healthkit-mapping";
import { admitAccountSettings } from "@/lib/export/account-settings-backup";
import { scanBackupJson } from "@/lib/export/backup-json-scan";
import { resolveLabCoding } from "@/lib/fhir/lab-loinc";
import { qualitativeValueConcept } from "@/lib/fhir/lab-qualitative";
import {
  mapGoogleHealthSleepStage,
  mapGoogleHealthSportType,
} from "@/lib/google-health/mappers";
import { canonicalJson } from "@/lib/idempotency";
import { guessMapping, readHead } from "@/lib/import/csv-mapping";
import { mapVital } from "@/lib/import/fhir-bundle/import";
import { normalizeJsonImportFile } from "@/lib/import/json/normalize";
import { mapFhirLabRecord } from "@/lib/labs/fhir-import/map-observation";
import { resolveRichMetric } from "@/lib/mcp/rich-reads";
import { mapAppleHealthEntry } from "@/lib/measurements/apple-health-mapping";
import { convertHkValue } from "@/lib/measurements/hk-units";
import { resolveHkWorkoutSportType } from "@/lib/measurements/hk-workout-activity-type-map";
import { getUnitForType } from "@/lib/measurements/unit-map";
import { normalisePrefs } from "@/lib/modules/gate";
import { surfaceModule } from "@/lib/modules/surface";
import {
  parseStoredMoodTagLayout,
  resolveMoodTagPlacement,
} from "@/lib/mood/tag-layout";
import { parseNutrientInputUnit } from "@/lib/nutrients/catalog";
import { redactSensitiveFields } from "@/lib/observability/redact-payload";
import { ownRecord, ownValue } from "@/lib/own-key";
import { managedModulePreferencesFrom } from "@/lib/record-settings/configuration";
import { parseCoachPrefs } from "@/lib/validations/coach-prefs";

import {
  assertAsyncProperty,
  assertProperty,
} from "../../../tests/property/fast-check";
import {
  PROTOTYPE_KEYS,
  expectPrototypesUntouched,
  prototypeKey,
  snapshotPrototypes,
  withPrototypeKeys,
} from "../../../tests/property/prototype-keys";

let before: string[][];
beforeAll(() => {
  before = snapshotPrototypes();
});
afterAll(() => {
  expectPrototypesUntouched(before);
});

/**
 * A JSON object whose own keys are the given names, built through
 * `JSON.parse` the way a file or request body arrives: `"__proto__"` becomes
 * an own member, not the object's prototype.
 */
function parsedObject(entries: [string, unknown][]): Record<string, unknown> {
  const text = `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`)
    .join(",")}}`;
  return JSON.parse(text) as Record<string, unknown>;
}

const keyedJunk = fc.array(
  fc.tuple(
    withPrototypeKeys(fc.string({ maxLength: 12 })),
    fc.oneof(
      fc.boolean(),
      fc.integer(),
      fc.string({ maxLength: 8 }),
      fc.constant(null),
      fc.dictionary(prototypeKey, fc.integer(), { maxKeys: 2 }),
    ),
  ),
  { maxLength: 6 },
);

describe("own-key helpers", () => {
  it("answers only for a table's own keys", () => {
    const table: Record<string, number> = { a: 1 };
    for (const key of PROTOTYPE_KEYS) {
      expect(ownValue(table, key)).toBeUndefined();
    }
    expect(ownValue(table, "a")).toBe(1);
  });

  it("keeps every key of a prototype-less map an ordinary entry", () => {
    const map = ownRecord<number>();
    for (const key of PROTOTYPE_KEYS as readonly string[])
      map[key] = (map[key] ?? 0) + 1;
    expect(Object.getPrototypeOf(map)).toBeNull();
    expect(Object.keys(map).sort()).toEqual([...PROTOTYPE_KEYS].sort());
    expectPrototypesUntouched(before);
  });
});

describe("FHIR readers", () => {
  it("maps a vital sign whose code and unit are prototype names to a reason", () => {
    assertProperty(
      fc.property(prototypeKey, prototypeKey, (code, unit) => {
        const out = mapVital(
          {
            resourceType: "Observation",
            status: "final",
            effectiveDateTime: "2026-03-02T08:00:00Z",
            code: { coding: [{ code }] },
            valueQuantity: { value: 70, code: unit, unit },
          },
          "x",
          new Date("2026-06-01T00:00:00Z"),
          "UTC",
        );
        expect(out).toHaveProperty("reason");
      }),
    );
  });

  it("resolves no lab coding for an analyte or unit spelled like a prototype member", () => {
    assertProperty(
      fc.property(prototypeKey, prototypeKey, (analyte, unit) => {
        expect(resolveLabCoding(analyte, unit)).toBeNull();
        expect(resolveLabCoding("glucose", unit)?.ucum ?? null).toBeNull();
        expect(qualitativeValueConcept(analyte)).toEqual({ text: analyte });
      }),
    );
  });

  it("maps a lab Observation with prototype-named codes without throwing", () => {
    assertProperty(
      fc.property(prototypeKey, prototypeKey, (code, unit) => {
        const out = mapFhirLabRecord({
          resource: {
            resourceType: "Observation",
            id: "o1",
            status: "final",
            code: { coding: [{ system: "http://loinc.org", code }] },
            effectiveDateTime: "2026-03-02T08:00:00Z",
            valueQuantity: { value: 5, unit, code: unit },
            interpretation: [{ coding: [{ code }] }],
          },
        });
        expect(out).toBeTypeOf("object");
      }),
    );
  });
});

describe("Apple Health readers", () => {
  it("routes a cycle sample with a prototype-named identifier or value to a skip", () => {
    assertProperty(
      fc.property(
        withPrototypeKeys(
          fc.constantFrom(
            "HKCategoryTypeIdentifierMenstrualFlow",
            "HKCategoryTypeIdentifierCervicalMucusQuality",
            "HKCategoryTypeIdentifierOvulationTestResult",
            "HKCategoryTypeIdentifierPregnancyTestResult",
            "HKCategoryTypeIdentifierContraceptive",
          ),
        ),
        prototypeKey,
        (identifier, value) => {
          const route = mapHkCycleSample(identifier, value);
          expect(route.kind).toBe("skip");
        },
      ),
    );
  });

  it("maps no record and converts no unit for prototype-named types and units", () => {
    assertProperty(
      fc.property(prototypeKey, prototypeKey, (identifier, unit) => {
        expect(
          mapAppleHealthEntry({
            hkIdentifier: identifier,
            value: 1,
            unit,
            startDate: "2026-03-02T08:00:00Z",
            endDate: "2026-03-02T08:00:00Z",
          }),
        ).toBeNull();
        expect(convertHkValue(1, unit, "kg")).toBeNull();
        expect(convertHkValue(1, "kg", unit)).toBeNull();
        expect(resolveHkWorkoutSportType(identifier).sportType).toBeTypeOf(
          "string",
        );
        expect(getUnitForType(identifier)).toBe("unknown");
      }),
    );
  });

  it("reads an ECG export whose metadata keys and classification are prototype names", async () => {
    await assertAsyncProperty(
      fc.asyncProperty(prototypeKey, prototypeKey, async (key, verdict) => {
        const csv = [
          "Name,Someone",
          `${key},${verdict}`,
          `Classification,${verdict}`,
          "Recorded Date,2026-03-02 08:00:00 +0100",
          "Sample Rate,512 hertz",
          "",
          "12.5",
          "13.0",
        ].join("\n");
        try {
          await parseAppleHealthEcgCsv({
            memberName: "electrocardiograms/ecg.csv",
            stream: Readable.from([Buffer.from(csv)]),
            maxSamples: 100,
          });
        } catch (err) {
          // A refusal is the parser's own error, never a TypeError.
          expect(err).not.toBeInstanceOf(TypeError);
        }
      }),
      50,
    );
  });
});

describe("CSV and JSON imports", () => {
  it("maps CSV headers spelled like prototype members to no field", () => {
    assertProperty(
      fc.property(
        fc.array(prototypeKey, { minLength: 1, maxLength: 6 }),
        fc.constantFrom("labs" as const, "medications" as const),
        (headers, kind) => {
          expect(Object.keys(guessMapping(headers, kind))).toEqual([]);
          const head = readHead(`${headers.join(",")}\n1,2\n`);
          expect(head.rows[0]).toEqual(headers);
        },
      ),
    );
  });

  it("normalises a JSON import whose entries carry prototype-named keys", () => {
    assertProperty(
      fc.property(keyedJunk, (entries) => {
        const entry = parsedObject(entries);
        const out = normalizeJsonImportFile({ measurements: [entry] });
        const [first] = (out.file as { measurements: object[] }).measurements;
        expect(Object.getPrototypeOf(first)).toBe(Object.prototype);
      }),
    );
  });
});

describe("backup restore", () => {
  it("scans members named like prototype members as members", async () => {
    await assertAsyncProperty(
      fc.asyncProperty(keyedJunk, async (entries) => {
        const text = JSON.stringify(parsedObject(entries));
        const { document } = await scanBackupJson(
          (async function* () {
            yield new TextEncoder().encode(text);
          })(),
        );
        expect(Object.getPrototypeOf(document)).toBeNull();
        expect({ ...document }).toEqual(JSON.parse(text));
      }),
    );
  });

  it("admits settings sections keyed by prototype names without throwing", () => {
    assertProperty(
      fc.property(keyedJunk, (entries) => {
        const section = parsedObject(entries);
        const admitted = admitAccountSettings(
          {
            thresholdsJson: section,
            activityGoalsJson: section,
            nutrientTargetsJson: section,
          },
          { operatorTrusted: false },
        );
        for (const value of Object.values(admitted.data)) {
          if (value && typeof value === "object") {
            expect(Object.getPrototypeOf(value)).not.toBe(section);
          }
        }
      }),
    );
  });
});

describe("stored preferences", () => {
  it("parses prototype-named keys in every stored preference document", () => {
    assertProperty(
      fc.property(keyedJunk, prototypeKey, (entries, key) => {
        const raw = parsedObject(entries);
        expect(parseCoachPrefs(raw)).toBeTypeOf("object");
        const prefs = normalisePrefs(raw);
        expect(Object.getPrototypeOf(prefs)).toBeNull();
        const modules = managedModulePreferencesFrom(raw);
        expect(Object.getPrototypeOf(modules)).toBe(Object.prototype);
        const layout = parseStoredMoodTagLayout({
          groupOrder: [key],
          placements: raw,
        });
        expect(
          resolveMoodTagPlacement({
            categoryKeysInSeededOrder: [key, "sleep"],
            tags: [{ key: "t1", homeCategoryKey: key }],
            layout,
          }),
        ).toBeTypeOf("object");
        expect(surfaceModule(key)).toBeUndefined();
      }),
    );
  });
});

describe("request and third-party payloads", () => {
  it("resolves no MCP metric, nutrient unit or Google Health type for a prototype name", () => {
    assertProperty(
      fc.property(prototypeKey, (key) => {
        expect(resolveRichMetric(key)).toBeNull();
        expect(parseNutrientInputUnit(key)).toBeNull();
        expect(mapGoogleHealthSleepStage(key)).toBeNull();
        expect(mapGoogleHealthSportType(key)).toBe("other");
      }),
    );
  });

  it("redacts and fingerprints bodies with prototype-named keys without swapping prototypes", () => {
    assertProperty(
      fc.property(keyedJunk, (entries) => {
        const body = parsedObject(entries);
        const out = redactSensitiveFields(body) as object;
        expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
        expect(Object.keys(out).sort()).toEqual(Object.keys(body).sort());
        expect(canonicalJson(body)).toBe(canonicalJson(parsedObject(entries)));
      }),
    );
  });
});
