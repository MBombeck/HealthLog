/**
 * Which `<ClinicalRecord>` elements reach the lab importer (#1400).
 *
 * Apple has written the `type` attribute two ways: the HealthKit clinical
 * type identifier (`HKClinicalTypeIdentifierLabResultRecord`), and, in
 * current exports, the FHIR resource type of the file (`Observation`,
 * `DiagnosticReport`, …). Both must route an Observation to the lab mapper,
 * which then decides by category; every other resource stays a counted skip.
 */
import { describe, expect, it } from "vitest";

import {
  routeClinicalRecord,
  type ClinicalLabReference,
} from "@/lib/apple-health/clinical-record-ref";

function route(attrs: Record<string, string | undefined>): {
  routed: boolean;
  refs: ClinicalLabReference[];
} {
  const refs: ClinicalLabReference[] = [];
  const routed = routeClinicalRecord(attrs, (ref) => void refs.push(ref));
  return { routed, refs };
}

const BASE = {
  identifier: "obs-1",
  sourceName: "Example Clinic",
  sourceURL: "https://fhir.example-clinic.test/R4",
  receivedDate: "2026-11-18 10:00:00 +0100",
};

describe("routeClinicalRecord", () => {
  it("routes the HealthKit lab-result identifier", () => {
    const { routed, refs } = route({
      ...BASE,
      type: "HKClinicalTypeIdentifierLabResultRecord",
      fhirVersion: "4.0.1",
      resourceFilePath: "/clinical-records/Observation-obs-1.json",
    });
    expect(routed).toBe(true);
    expect(refs).toEqual([
      {
        path: "/clinical-records/Observation-obs-1.json",
        identifier: "obs-1",
        sourceURL: "https://fhir.example-clinic.test/R4",
        sourceName: "Example Clinic",
        fhirVersion: "4.0.1",
      },
    ]);
  });

  it.each(["4.0.1", "1.0.2"])(
    "routes an Observation named by its FHIR resource type (FHIR %s)",
    (fhirVersion) => {
      const { routed, refs } = route({
        ...BASE,
        type: "Observation",
        fhirVersion,
        resourceFilePath: "/clinical-records/Observation-obs-1.json",
      });
      expect(routed).toBe(true);
      expect(refs).toHaveLength(1);
      expect(refs[0].fhirVersion).toBe(fhirVersion);
      expect(refs[0].path).toBe("/clinical-records/Observation-obs-1.json");
    },
  );

  it("falls back to the file name when the type attribute is missing", () => {
    expect(
      route({
        ...BASE,
        fhirVersion: "4.0.1",
        resourceFilePath: "/clinical-records/Observation-obs-1.json",
      }).routed,
    ).toBe(true);
    expect(
      route({
        ...BASE,
        type: "",
        resourceFilePath: "clinical-records/Observation-obs-1.json",
      }).routed,
    ).toBe(true);
    expect(
      route({
        ...BASE,
        resourceFilePath: "/clinical-records/Condition-cond-1.json",
      }).routed,
    ).toBe(false);
  });

  it.each([
    "DiagnosticReport",
    "MedicationRequest",
    "DocumentReference",
    "Condition",
    "Immunization",
    "Procedure",
    "AllergyIntolerance",
    "Patient",
  ])("skips a %s", (type) => {
    const { routed, refs } = route({
      ...BASE,
      type,
      fhirVersion: "4.0.1",
      resourceFilePath: `/clinical-records/${type}-x.json`,
    });
    expect(routed).toBe(false);
    expect(refs).toEqual([]);
  });

  it("skips other HealthKit clinical types, whatever the file is called", () => {
    for (const type of [
      "HKClinicalTypeIdentifierVitalSignRecord",
      "HKClinicalTypeIdentifierConditionRecord",
    ]) {
      expect(
        route({
          ...BASE,
          type,
          resourceFilePath: "/clinical-records/Observation-vs-1.json",
        }).routed,
      ).toBe(false);
    }
  });

  it("does not trust the file name over a stated resource type", () => {
    expect(
      route({
        ...BASE,
        type: "DiagnosticReport",
        resourceFilePath: "/clinical-records/Observation-obs-1.json",
      }).routed,
    ).toBe(false);
  });

  it("skips everything without a callback", () => {
    expect(
      routeClinicalRecord({
        ...BASE,
        type: "Observation",
        resourceFilePath: "/clinical-records/Observation-obs-1.json",
      }),
    ).toBe(false);
  });
});
