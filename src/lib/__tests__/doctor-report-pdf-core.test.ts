import { describe, it, expect } from "vitest";
import { PDFParse } from "pdf-parse";
import {
  buildDoctorReportPdfDocument,
  renderDoctorReportPdfBytes,
  DOCTOR_REPORT_VITAL_TYPES,
  DOCTOR_REPORT_TYPE_LABEL_KEYS,
  DOCTOR_REPORT_TYPE_UNIT_KEYS,
} from "../doctor-report-pdf-core";
import { measurementTypeEnum } from "../validations/measurement";
import type { DoctorReportData } from "../doctor-report-data";
import { getServerTranslator } from "../i18n/server-translator";

async function extractText(bytes: Uint8Array): Promise<string> {
  const parser = new PDFParse({ data: bytes });
  try {
    const result = await parser.getText();
    return result.text;
  } finally {
    await parser.destroy();
  }
}

const FIXED_NOW = new Date("2026-05-03T12:00:00.000Z");

function makeData(overrides?: Partial<DoctorReportData>): DoctorReportData {
  return {
    period: { days: 90, since: "2026-02-02T00:00:00.000Z" },
    patient: {
      username: "marc",
      dateOfBirth: "1985-06-15T00:00:00.000Z",
      gender: "MALE",
      heightCm: 182,
    },
    measurements: {
      WEIGHT: [
        { value: 80, measuredAt: "2026-02-10T08:00:00.000Z" },
        { value: 79.5, measuredAt: "2026-04-30T08:00:00.000Z" },
      ],
    },
    stats: {
      WEIGHT: { avg: 79.75, min: 79.5, max: 80, count: 2, latest: 79.5 },
      BLOOD_PRESSURE_SYS: {
        avg: 122,
        min: 118,
        max: 128,
        count: 5,
        latest: 120,
      },
      BLOOD_PRESSURE_DIA: {
        avg: 78,
        min: 72,
        max: 82,
        count: 5,
        latest: 78,
      },
      PULSE: { avg: 65, min: 58, max: 72, count: 5, latest: 64 },
    },
    glucoseStats: {
      FASTING: { avg: 92, min: 85, max: 100, count: 4, latest: 90 },
    },
    glucoseRanges: { FASTING: { min: 70, max: 99 } },
    glucoseUnit: "mg/dL",
    bmi: 24.1,
    compliance: {
      Ramipril: { total: 90, taken: 85, skipped: 3, missed: 2 },
    },
    medications: [
      {
        name: "Ramipril",
        dose: "5mg",
        schedules: [
          { windowStart: "08:00", windowEnd: "09:00", label: "Morning" },
        ],
      },
    ],
    mood: {
      avg: 3.6,
      min: 2,
      max: 5,
      count: 30,
      distribution: { 1: 0, 2: 3, 3: 9, 4: 14, 5: 4 },
    },
    ...overrides,
  };
}

describe("renderDoctorReportPdfBytes", () => {
  it("returns a Uint8Array starting with the %PDF- header", () => {
    const { t } = getServerTranslator("de");
    const bytes = renderDoctorReportPdfBytes(makeData(), {
      t,
      locale: "de",
      now: FIXED_NOW,
    });
    expect(bytes).toBeInstanceOf(Uint8Array);
    const header = String.fromCharCode(...bytes.slice(0, 5));
    expect(header).toBe("%PDF-");
  });

  it("produces a non-trivial document (> 1 KB)", () => {
    const { t } = getServerTranslator("de");
    const bytes = renderDoctorReportPdfBytes(makeData(), {
      t,
      locale: "de",
      now: FIXED_NOW,
    });
    expect(bytes.byteLength).toBeGreaterThan(1024);
  });

  it("is structurally deterministic for the same input + fixed timestamp", () => {
    // jsPDF embeds a per-invocation file-id in the trailer (random UUID-like
    // hex). The visible content is fully determined by the inputs, so we
    // assert byte-length equality + identical content sections instead of a
    // strict bytewise compare.
    const { t } = getServerTranslator("de");
    const a = renderDoctorReportPdfBytes(makeData(), {
      t,
      locale: "de",
      now: FIXED_NOW,
    });
    const b = renderDoctorReportPdfBytes(makeData(), {
      t,
      locale: "de",
      now: FIXED_NOW,
    });
    expect(a.byteLength).toBe(b.byteLength);
    // Compare the first 95% of the document — file-id and trailer differ.
    const cmp = Math.floor(a.byteLength * 0.95);
    expect(
      Buffer.from(a.slice(0, cmp)).equals(Buffer.from(b.slice(0, cmp))),
    ).toBe(true);
  });

  it("renders both DE and EN locales without errors", () => {
    const de = renderDoctorReportPdfBytes(makeData(), {
      t: getServerTranslator("de").t,
      locale: "de",
      now: FIXED_NOW,
    });
    const en = renderDoctorReportPdfBytes(makeData(), {
      t: getServerTranslator("en").t,
      locale: "en",
      now: FIXED_NOW,
    });
    expect(de.byteLength).toBeGreaterThan(1024);
    expect(en.byteLength).toBeGreaterThan(1024);
  });

  it("handles empty stats / no mood without throwing", () => {
    const empty = makeData({
      stats: {},
      glucoseStats: {},
      glucoseRanges: {},
      compliance: {},
      mood: null,
      bmi: null,
    });
    const bytes = renderDoctorReportPdfBytes(empty, {
      t: getServerTranslator("de").t,
      locale: "de",
      now: FIXED_NOW,
    });
    const header = String.fromCharCode(...bytes.slice(0, 5));
    expect(header).toBe("%PDF-");
  });
});

describe("buildDoctorReportPdfDocument", () => {
  it("returns a jsPDF doc with at least one page", () => {
    const doc = buildDoctorReportPdfDocument(makeData(), {
      t: getServerTranslator("de").t,
      locale: "de",
      now: FIXED_NOW,
    });
    expect(doc.getNumberOfPages()).toBeGreaterThanOrEqual(1);
  });
});

// Audit-2026-05-07 / phase P0 / closes audit C-9: server-side PDF used a
// stale type map and silently dropped body composition while the browser
// PDF rendered them. These tests pin the contract.
describe("doctor-report-pdf-core type-map coverage", () => {
  it("exposes body composition (TOTAL_BODY_WATER, BONE_MASS) as vital types", () => {
    expect(DOCTOR_REPORT_VITAL_TYPES).toContain("TOTAL_BODY_WATER");
    expect(DOCTOR_REPORT_VITAL_TYPES).toContain("BONE_MASS");
  });

  it("provides a label key + unit for every vital type", () => {
    for (const type of DOCTOR_REPORT_VITAL_TYPES) {
      expect(DOCTOR_REPORT_TYPE_LABEL_KEYS[type]).toBeTruthy();
      const unit = DOCTOR_REPORT_TYPE_UNIT_KEYS[type];
      expect(
        unit === null || (typeof unit === "string" && unit.length > 0),
      ).toBe(true);
    }
  });

  it("vital types are a subset of the canonical measurement enum", () => {
    const enumSet = new Set<string>(measurementTypeEnum.options);
    for (const type of DOCTOR_REPORT_VITAL_TYPES) {
      expect(enumSet.has(type), `${type} not in measurementTypeEnum`).toBe(
        true,
      );
    }
  });

  it("renders body composition rows with their German labels in the document text", async () => {
    const data = makeData({
      stats: {
        WEIGHT: { avg: 80, min: 79, max: 81, count: 5, latest: 80 },
        TOTAL_BODY_WATER: {
          avg: 42,
          min: 40,
          max: 44,
          count: 5,
          latest: 42,
        },
        BONE_MASS: { avg: 3.2, min: 3.1, max: 3.3, count: 5, latest: 3.2 },
      },
    });
    const bytes = renderDoctorReportPdfBytes(data, {
      t: getServerTranslator("de").t,
      locale: "de",
      now: FIXED_NOW,
    });
    const text = await extractText(bytes);
    expect(text).toContain("Gesamtkörperwasser");
    expect(text).toContain("Knochenmasse");
    expect(text).toContain("42,0");
    expect(text).toContain("3,2");
  });

  it("renders an OXYGEN_SATURATION row with the SpO2 label when stats are supplied", async () => {
    const data = makeData({
      stats: {
        WEIGHT: { avg: 80, min: 79, max: 81, count: 5, latest: 80 },
        OXYGEN_SATURATION: {
          avg: 97.4,
          min: 95,
          max: 99,
          count: 12,
          latest: 98,
        },
      },
    });
    const bytes = renderDoctorReportPdfBytes(data, {
      t: getServerTranslator("de").t,
      locale: "de",
      now: FIXED_NOW,
    });
    const text = await extractText(bytes);
    expect(text).toContain("Sauerstoffsättigung");
    expect(text).toContain("97,4");
    expect(text).toContain("%");
  });

  it("renders body composition rows in English when locale is en", async () => {
    const data = makeData({
      stats: {
        WEIGHT: { avg: 80, min: 79, max: 81, count: 5, latest: 80 },
        TOTAL_BODY_WATER: { avg: 42, min: 40, max: 44, count: 5, latest: 42 },
        BONE_MASS: { avg: 3.2, min: 3.1, max: 3.3, count: 5, latest: 3.2 },
        OXYGEN_SATURATION: {
          avg: 97.4,
          min: 95,
          max: 99,
          count: 12,
          latest: 98,
        },
      },
    });
    const bytes = renderDoctorReportPdfBytes(data, {
      t: getServerTranslator("en").t,
      locale: "en",
      now: FIXED_NOW,
    });
    const text = await extractText(bytes);
    expect(text).toContain("Total body water");
    expect(text).toContain("Bone mass");
    expect(text).toContain("Oxygen saturation");
  });
});
