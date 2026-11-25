/**
 * The rules the whole backup file carries beyond its slices: what an absent
 * section restores as, the manifest's shape, the relation links' key names,
 * the lab-unit rule across markers and readings, the stable-id rule of a v2
 * file, and the string form `parseBackupPayload` accepts.
 */
import { describe, expect, it } from "vitest";

import { backupPayloadSchema, parseBackupPayload } from "../backup";

const AT = "2026-07-01T08:00:00.000Z";
const MINIMAL = { schemaVersion: "1", exportedAt: AT, userId: "u1" };

/** `[path, message]` of every issue a payload raises. */
function issues(payload: unknown): Array<[string, string]> {
  const result = backupPayloadSchema.safeParse(payload);
  return result.success
    ? []
    : result.error.issues.map((i) => [i.path.join("."), i.message]);
}

describe("a file that omits a section", () => {
  it("restores every list section empty, never with invented rows", () => {
    const parsed = parseBackupPayload(MINIMAL) as Record<string, unknown>;
    const lists = Object.entries(parsed).filter(([, v]) => Array.isArray(v));
    // Every section the schema defaults to a list: a smaller count means
    // this check stopped seeing them.
    expect(lists.length).toBeGreaterThanOrEqual(60);
    for (const [key, value] of lists) {
      expect(value, key).toEqual([]);
    }
  });

  it("restores the settings and the manifest as absent", () => {
    const parsed = parseBackupPayload(MINIMAL);
    expect(parsed.appSettings).toBeNull();
    expect(parsed.accountSettings).toBeNull();
    expect(parsed.manifest).toBeNull();
  });

  it("reads a file without a version as the legacy one", () => {
    const { schemaVersion: _v, ...unversioned } = MINIMAL;
    void _v;
    expect(parseBackupPayload(unversioned).schemaVersion).toBe("1");
  });
});

describe("the schema version", () => {
  it("is carried as written, however long", () => {
    expect(
      parseBackupPayload({ ...MINIMAL, schemaVersion: "12" }).schemaVersion,
    ).toBe("12");
  });

  it("may not be empty", () => {
    expect(issues({ ...MINIMAL, schemaVersion: "" }).map(([p]) => p)).toEqual([
      "schemaVersion",
    ]);
  });

  it("needs the export stamp and the owner", () => {
    expect(
      issues({ schemaVersion: "1" })
        .map(([p]) => p)
        .sort(),
    ).toEqual(["exportedAt", "userId"]);
    expect(issues({ ...MINIMAL, userId: "" }).map(([p]) => p)).toEqual([
      "userId",
    ]);
  });
});

describe("the manifest", () => {
  const manifest = {
    documents: { included: "metadata", note: "File bytes stay on the host." },
    workouts: { included: "full", note: "Routes included." },
  };

  it("restores both entries as written", () => {
    expect(parseBackupPayload({ ...MINIMAL, manifest }).manifest).toEqual(
      manifest,
    );
  });

  it.each(["documents", "workouts"])("needs its %s entry", (entry) => {
    const { [entry as "documents"]: _gone, ...rest } = manifest;
    void _gone;
    expect(issues({ ...MINIMAL, manifest: rest }).map(([p]) => p)).toEqual([
      `manifest.${entry}`,
    ]);
  });

  it.each([
    ["documents", "included"],
    ["documents", "note"],
    ["workouts", "included"],
    ["workouts", "note"],
  ])("refuses an empty %s.%s", (entry, field) => {
    const broken = {
      ...manifest,
      [entry]: { ...manifest[entry as "documents"], [field]: "" },
    };
    expect(issues({ ...MINIMAL, manifest: broken }).map(([p]) => p)).toEqual([
      `manifest.${entry}.${field}`,
    ]);
  });
});

describe("the relation links", () => {
  it.each([
    ["labResultDocumentLinks", "labResultId", "documentId"],
    ["encounterMedicationLinks", "encounterId", "medicationId"],
    ["encounterVaccinationLinks", "encounterId", "vaccinationId"],
    ["medicationDocumentLinks", "medicationId", "documentId"],
    ["medicationConditionLinks", "medicationId", "episodeId"],
  ])("%s keys on %s and %s", (section, a, b) => {
    const link = { [a]: "left-1", [b]: "right-1", createdAt: AT };
    const parsed = parseBackupPayload({ ...MINIMAL, [section]: [link] });
    expect((parsed as Record<string, unknown>)[section]).toEqual([link]);
    for (const key of [a, b]) {
      const { [key]: _gone, ...partial } = link;
      void _gone;
      expect(
        issues({ ...MINIMAL, [section]: [partial] }).map(([p]) => p),
      ).toEqual([`${section}.0.${key}`]);
    }
  });
});

describe("a lab marker's unit against its readings", () => {
  const marker = { id: "bm-1", name: "Urine glucose", unit: "" };
  const reading = {
    analyte: "Urine glucose",
    value: 5,
    valueText: null,
    unit: "mg/dL",
    takenAt: AT,
    source: "MANUAL",
  };
  const refusal: [string, string] = [
    "biomarkers.0.unit",
    'Biomarker "Urine glucose" has numeric readings and needs its unit',
  ];

  it("refuses a unitless marker a numeric reading is filed under by id", () => {
    expect(
      issues({
        ...MINIMAL,
        biomarkers: [marker],
        labResults: [{ ...reading, biomarkerId: "bm-1", biomarkerName: null }],
      }),
    ).toEqual([refusal]);
  });

  it("refuses a unitless marker a numeric reading is filed under by name", () => {
    expect(
      issues({
        ...MINIMAL,
        biomarkers: [marker],
        labResults: [
          { ...reading, biomarkerId: null, biomarkerName: "Urine glucose" },
        ],
      }),
    ).toEqual([refusal]);
  });

  it("takes a unitless marker whose readings are all qualitative", () => {
    expect(
      issues({
        ...MINIMAL,
        biomarkers: [marker],
        labResults: [
          {
            ...reading,
            value: null,
            valueText: "negative",
            unit: "",
            biomarkerId: "bm-1",
            biomarkerName: "Urine glucose",
          },
        ],
      }),
    ).toEqual([]);
  });

  it("takes a unitless marker when the numeric reading belongs to another", () => {
    expect(
      issues({
        ...MINIMAL,
        biomarkers: [marker, { id: "bm-2", name: "Glucose", unit: "mg/dL" }],
        labResults: [
          { ...reading, biomarkerId: "bm-2", biomarkerName: "Glucose" },
        ],
      }),
    ).toEqual([]);
  });

  it("takes a numeric reading under a marker that has its unit", () => {
    expect(
      issues({
        ...MINIMAL,
        biomarkers: [{ ...marker, unit: "mg/dL" }],
        labResults: [{ ...reading, biomarkerId: "bm-1" }],
      }),
    ).toEqual([]);
  });
});

describe("a canonical v2 file", () => {
  const measurement = {
    type: "WEIGHT",
    value: 72.5,
    unit: "kg",
    measuredAt: AT,
  };

  it("names each measurement that lacks its stable id", () => {
    expect(
      issues({
        ...MINIMAL,
        schemaVersion: "2",
        measurements: [{ ...measurement, id: "m-1" }, measurement],
      }),
    ).toEqual([
      ["measurements.1.id", "Canonical v2 measurements require a stable id"],
    ]);
  });

  it("takes measurements that all carry one", () => {
    expect(
      issues({
        ...MINIMAL,
        schemaVersion: "2",
        measurements: [{ ...measurement, id: "m-1" }],
      }),
    ).toEqual([]);
  });
});

describe("parseBackupPayload", () => {
  it("reads the JSON text a stored backup holds", () => {
    const parsed = parseBackupPayload(JSON.stringify(MINIMAL));
    expect(parsed.userId).toBe("u1");
    expect(parsed.exportedAt).toBe(AT);
  });

  it("throws on a file that does not match", () => {
    expect(() => parseBackupPayload({ schemaVersion: "1" })).toThrow();
  });
});
