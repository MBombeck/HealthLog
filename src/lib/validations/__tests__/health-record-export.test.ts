import { describe, it, expect } from "vitest";
import {
  exportSelectionSchema,
  toDoctorReportPrefs,
} from "../health-record-export";

describe("exportSelectionSchema", () => {
  it("accepts a minimal valid payload", () => {
    const parsed = exportSelectionSchema.safeParse({ format: "pdf" });
    expect(parsed.success).toBe(true);
  });

  it("accepts each supported format", () => {
    for (const format of ["pdf", "fhir", "package"]) {
      expect(exportSelectionSchema.safeParse({ format }).success).toBe(true);
    }
  });

  it("rejects an unknown format", () => {
    const parsed = exportSelectionSchema.safeParse({ format: "xml" });
    expect(parsed.success).toBe(false);
  });

  it("rejects a missing format", () => {
    expect(exportSelectionSchema.safeParse({}).success).toBe(false);
  });

  it("rejects unknown top-level keys (.strict)", () => {
    const parsed = exportSelectionSchema.safeParse({
      format: "pdf",
      unexpected: true,
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a userId smuggled into the body", () => {
    const parsed = exportSelectionSchema.safeParse({
      format: "pdf",
      userId: "someone-else",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects an unknown key inside range (.strict)", () => {
    const parsed = exportSelectionSchema.safeParse({
      format: "fhir",
      range: { days: 30, evil: 1 },
    });
    expect(parsed.success).toBe(false);
  });

  it("enforces the range.days cap (1..365)", () => {
    expect(
      exportSelectionSchema.safeParse({ format: "pdf", range: { days: 0 } })
        .success,
    ).toBe(false);
    expect(
      exportSelectionSchema.safeParse({ format: "pdf", range: { days: 366 } })
        .success,
    ).toBe(false);
    expect(
      exportSelectionSchema.safeParse({ format: "pdf", range: { days: 365 } })
        .success,
    ).toBe(true);
  });

  it("returns all issues, not just the first", () => {
    const parsed = exportSelectionSchema.safeParse({
      format: "xml",
      range: { days: 9999 },
      unknownKey: 1,
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.length).toBeGreaterThan(1);
    }
  });
});

describe("toDoctorReportPrefs", () => {
  it("defaults to every section on except mood when no selection given", () => {
    const prefs = toDoctorReportPrefs(undefined);
    expect(prefs.weight).toBe(true);
    expect(prefs.bp).toBe(true);
    expect(prefs.mood).toBe(false);
  });

  it("keeps mood off unless explicitly true", () => {
    expect(toDoctorReportPrefs({ mood: false }).mood).toBe(false);
    expect(toDoctorReportPrefs({}).mood).toBe(false);
    expect(toDoctorReportPrefs({ mood: true }).mood).toBe(true);
  });

  it("folds grouped vitals down to the flat shape", () => {
    const prefs = toDoctorReportPrefs({
      vitals: { weight: false, bp: true },
    });
    expect(prefs.weight).toBe(false);
    expect(prefs.bp).toBe(true);
  });

  it("maps medication compliance toggle", () => {
    expect(
      toDoctorReportPrefs({ medications: { compliance: false } }).compliance,
    ).toBe(false);
  });
});
