import { describe, it, expect, vi } from "vitest";
import { buildHeaderProfileSection } from "../header-profile-section";
import type {
  DoctorReportPdfRenderContext,
  DoctorReportPdfCursorState,
} from "../render-context";

/**
 * A line on a clinical cover sheet is a positive claim about the patient.
 * The gender row used to label ANY unrecognised stored string as the third
 * value, so a legacy or malformed value asserted something the account
 * never chose. Absence has to read as absence.
 */
function renderPatientLines(gender: string | null): string[] {
  const lines: string[] = [];
  const doc = {
    setFontSize: vi.fn(),
    setFont: vi.fn(),
    setTextColor: vi.fn(),
    setDrawColor: vi.fn(),
    setLineWidth: vi.fn(),
    line: vi.fn(),
    addPage: vi.fn(),
    getNumberOfPages: () => 1,
    splitTextToSize: (s: string) => [s],
    text: (line: string) => {
      lines.push(line);
    },
    internal: { pageSize: { getWidth: () => 210, getHeight: () => 297 } },
  };
  const context = {
    doc,
    data: {
      patient: {
        name: "testuser",
        dateOfBirth: null,
        gender,
        heightCm: null,
        insurerName: null,
        insurerIkNumber: null,
      },
      period: {
        since: "2026-06-01T00:00:00.000Z",
        start: null,
        end: null,
        days: 30,
      },
      practiceName: null,
      measurements: {},
      stats: {},
      compliance: {},
    },
    // The translator echoes the key so an assertion can name the label it
    // expects instead of a locale string.
    t: (key: string) => key,
    num: (value: number) => String(value),
    fmtDate: (iso: string) => iso.slice(0, 10),
    now: new Date("2026-07-26T00:00:00.000Z"),
    insuranceNumber: null,
    margin: 15,
    pageWidth: 210,
    contentMaxY: 280,
    ensureSpace: (current: number) => current,
  } as unknown as DoctorReportPdfRenderContext;
  buildHeaderProfileSection(context, {
    y: 20,
  } as unknown as DoctorReportPdfCursorState);
  return lines;
}

describe("doctor-report cover — gender row", () => {
  it("labels each of the three stored values", () => {
    expect(renderPatientLines("MALE")).toContain(
      "doctorReport.gender: doctorReport.genderMale",
    );
    expect(renderPatientLines("FEMALE")).toContain(
      "doctorReport.gender: doctorReport.genderFemale",
    );
    expect(renderPatientLines("OTHER")).toContain(
      "doctorReport.gender: doctorReport.genderOther",
    );
  });

  it("omits the row entirely for no answer or an unrecognised value", () => {
    for (const stored of [null, "", "diverse", "male"]) {
      const lines = renderPatientLines(stored);
      expect(
        lines.some((line) => line.startsWith("doctorReport.gender:")),
      ).toBe(false);
    }
  });
});
