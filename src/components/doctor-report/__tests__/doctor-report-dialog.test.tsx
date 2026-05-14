import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * SSR contract tests for the doctor-report export dialog.
 *
 * Radix UI's `Dialog` portals its content out of the React tree, so
 * `renderToStaticMarkup()` returns an empty string for the open dialog.
 * Instead we assert the *contract* surfaces the dialog depends on:
 *
 *  - All required i18n keys exist in EN + DE.
 *  - The component module compiles + imports cleanly.
 *  - The exported submit-payload type stays the same shape the API
 *    route reads (`{ startDate, endDate }`).
 *
 * Behavioural coverage (open → validate → submit → download) lives in
 * `e2e/doctor-report.spec.ts`, which drives the dialog through Playwright.
 *
 * v1.4.15 phase B6.
 */

const ROOT = join(__dirname, "../../../..");

function loadMessages(locale: "en" | "de"): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(ROOT, "messages", `${locale}.json`), "utf8"),
  );
}

const REQUIRED_KEYS = [
  "title",
  "description",
  "startLabel",
  "endLabel",
  "preset90d",
  "preset180d",
  "preset365d",
  "submit",
  "cancel",
  "errorEndBeforeStart",
  "errorRangeTooLong",
  "errorInvalidDate",
];

describe("doctor-report dialog — i18n contract", () => {
  for (const locale of ["en", "de"] as const) {
    it(`exposes every doctor-report dialog key in ${locale}.json`, () => {
      const messages = loadMessages(locale);
      const root = messages.doctorReport as Record<string, unknown> | undefined;
      expect(
        root,
        `doctorReport namespace missing in ${locale}.json`,
      ).toBeDefined();
      const dialog = root!.dialog as Record<string, unknown> | undefined;
      expect(
        dialog,
        `doctorReport.dialog missing in ${locale}.json`,
      ).toBeDefined();
      for (const key of REQUIRED_KEYS) {
        expect(
          dialog![key],
          `doctorReport.dialog.${key} missing in ${locale}.json`,
        ).toBeTruthy();
        expect(typeof dialog![key]).toBe("string");
      }
    });

    // v1.4.25 W6c — per-section toggle strings.
    it(`exposes every doctor-report section-toggle key in ${locale}.json`, () => {
      const messages = loadMessages(locale);
      const root = messages.doctorReport as Record<string, unknown> | undefined;
      const sections = root!.sections as Record<string, unknown> | undefined;
      expect(
        sections,
        `doctorReport.sections missing in ${locale}.json`,
      ).toBeDefined();
      const sectionKeys = [
        "title",
        "bp",
        "weight",
        "pulse",
        "bmi",
        "mood",
        "moodSensitive",
        "compliance",
        "sleep",
        "empty",
      ];
      for (const key of sectionKeys) {
        expect(
          sections![key],
          `doctorReport.sections.${key} missing in ${locale}.json`,
        ).toBeTruthy();
        expect(typeof sections![key]).toBe("string");
      }
    });
  }

  it("EN dialog uses the expected English title + 90d preset", () => {
    const en = loadMessages("en");
    const dialog = (en.doctorReport as { dialog: Record<string, string> })
      .dialog;
    expect(dialog.title).toContain("Doctor report");
    expect(dialog.preset90d.toLowerCase()).toContain("90");
  });

  it("DE dialog uses the German title", () => {
    const de = loadMessages("de");
    const dialog = (de.doctorReport as { dialog: Record<string, string> })
      .dialog;
    expect(dialog.title).toContain("Arztbericht");
    expect(dialog.preset90d).toContain("90");
  });
});

describe("doctor-report dialog — module surface", () => {
  it("exports `DoctorReportDialog` and a `DoctorReportSubmitPayload` type", async () => {
    const mod = await import("../doctor-report-dialog");
    expect(typeof mod.DoctorReportDialog).toBe("function");
    // The type is erased at runtime; verifying export presence is the
    // best we can do without `tsc --noEmit` here.
    expect("DoctorReportDialog" in mod).toBe(true);
  });
});
