import { describe, expect, it } from "vitest";

import { fhirLabExternalId, fhirLabIssuer } from "../external-id";

const AT = new Date("2025-03-04T07:15:00Z");

describe("fhirLabExternalId", () => {
  it("gives the export and the HealthKit record the same id", () => {
    const fromExport = fhirLabExternalId({
      sourceURL: "https://FHIR.example-health.test/api/R4/",
      sourceName: "Example Health",
      identifier: "obs-1",
      resourceId: "obs-1",
      analyte: "LDL",
      takenAt: AT,
      value: 3.1,
      valueText: null,
    });
    const fromPhone = fhirLabExternalId({
      sourceURL: "https://fhir.example-health.test/api/R4",
      sourceName: "Example Health (renamed)",
      identifier: "obs-1",
      analyte: "LDL Cholesterol",
      takenAt: new Date("2025-03-05T00:00:00Z"),
      value: 80,
      valueText: null,
    });
    expect(fromExport).toBe(fromPhone);
    expect(fromExport).toMatch(/^fhir:[0-9a-f]{40}$/);
  });

  it("keeps two institutions apart", () => {
    const a = fhirLabExternalId({
      sourceURL: "https://a.test",
      identifier: "obs-1",
      analyte: "x",
      takenAt: AT,
      value: 1,
      valueText: null,
    });
    const b = fhirLabExternalId({
      sourceURL: "https://b.test",
      identifier: "obs-1",
      analyte: "x",
      takenAt: AT,
      value: 1,
      valueText: null,
    });
    expect(a).not.toBe(b);
  });

  it("falls back to a stable content identity", () => {
    const input = {
      sourceName: "Clinic",
      loinc: "2345-7",
      analyte: " Glucose ",
      takenAt: AT,
      value: 92,
      valueText: null,
    };
    const first = fhirLabExternalId(input);
    expect(first).toMatch(/^fhirc:[0-9a-f]{40}$/);
    expect(fhirLabExternalId({ ...input, analyte: "glucose" })).toBe(first);
    expect(fhirLabExternalId({ ...input, value: 93 })).not.toBe(first);
  });

  it("names the issuer by URL, then name, then unknown", () => {
    expect(fhirLabIssuer({ sourceURL: " https://X.test/// " })).toBe(
      "https://x.test",
    );
    expect(fhirLabIssuer({ sourceName: " Clinic " })).toBe("Clinic");
    expect(fhirLabIssuer({})).toBe("unknown");
  });
});
