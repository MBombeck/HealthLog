import { describe, expect, it } from "vitest";

import {
  DEFAULT_DOCTOR_REPORT_PREFS,
  doctorReportPrefsSchema,
  parseDoctorReportPrefs,
  resolveDoctorReportPrefs,
} from "../doctor-report-prefs";

/**
 * v1.4.25 W6c — per-user Doctor-Report section toggles.
 */
describe("doctorReportPrefsSchema", () => {
  it("accepts an empty object (every key is optional)", () => {
    const out = doctorReportPrefsSchema.parse({});
    expect(out).toEqual({});
  });

  it("accepts the full shape and round-trips it", () => {
    const input = {
      bp: true,
      weight: false,
      pulse: true,
      bmi: true,
      mood: false,
      compliance: true,
      sleep: false,
    };
    const out = doctorReportPrefsSchema.parse(input);
    expect(out).toEqual(input);
  });

  it("accepts a partial update (only the toggled keys)", () => {
    const out = doctorReportPrefsSchema.parse({ mood: true });
    expect(out).toEqual({ mood: true });
  });

  it("rejects a non-boolean value", () => {
    const result = doctorReportPrefsSchema.safeParse({ bp: "yes" });
    expect(result.success).toBe(false);
  });
});

describe("parseDoctorReportPrefs", () => {
  it("returns defaults for null input", () => {
    expect(parseDoctorReportPrefs(null)).toEqual(DEFAULT_DOCTOR_REPORT_PREFS);
  });

  it("returns defaults for undefined input", () => {
    expect(parseDoctorReportPrefs(undefined)).toEqual(
      DEFAULT_DOCTOR_REPORT_PREFS,
    );
  });

  it("defaults mood to OFF (privacy directive per Marc)", () => {
    const out = parseDoctorReportPrefs(null);
    expect(out.mood).toBe(false);
  });

  it("fills missing keys from defaults", () => {
    const out = parseDoctorReportPrefs({ bp: false });
    expect(out).toEqual({
      ...DEFAULT_DOCTOR_REPORT_PREFS,
      bp: false,
    });
  });

  it("returns defaults for malformed input (forward-compat fallback)", () => {
    expect(parseDoctorReportPrefs({ bp: "nope" })).toEqual(
      DEFAULT_DOCTOR_REPORT_PREFS,
    );
    expect(parseDoctorReportPrefs("not an object")).toEqual(
      DEFAULT_DOCTOR_REPORT_PREFS,
    );
  });
});

describe("resolveDoctorReportPrefs", () => {
  it("layers a partial update over current persisted values", () => {
    const current = {
      bp: false,
      weight: false,
      pulse: false,
      bmi: false,
      mood: true,
      compliance: false,
      sleep: false,
    };
    const out = resolveDoctorReportPrefs(current, { mood: false });
    expect(out).toEqual({ ...current, mood: false });
  });

  it("layers a partial update over defaults when current is null", () => {
    const out = resolveDoctorReportPrefs(null, { mood: true });
    expect(out).toEqual({ ...DEFAULT_DOCTOR_REPORT_PREFS, mood: true });
  });
});
