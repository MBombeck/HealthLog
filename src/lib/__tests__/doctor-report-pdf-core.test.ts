import { describe, it, expect } from "vitest";
import { PDFParse } from "pdf-parse";
import {
  buildDoctorReportPdfDocument,
  renderDoctorReportPdfBytes,
  sanitiseForPdf,
  DOCTOR_REPORT_VITAL_TYPES,
  DOCTOR_REPORT_TYPE_LABEL_KEYS,
  DOCTOR_REPORT_TYPE_UNIT_KEYS,
} from "../doctor-report-pdf-core";
import { measurementTypeEnum } from "../validations/measurement";
import type { DoctorReportData } from "../doctor-report-data";
import { computeGlucoseClinicalMetrics } from "@/lib/analytics/glucose-metrics";
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
    period: {
      days: 90,
      since: "2026-02-02T00:00:00.000Z",
      start: "2026-02-02T00:00:00.000Z",
      end: "2026-05-03T12:00:00.000Z",
    },
    patient: {
      username: "testuser",
      dateOfBirth: "1985-06-15T00:00:00.000Z",
      gender: "MALE",
      heightCm: 182,
    },
    practiceName: null,
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
    glucoseClinical: computeGlucoseClinicalMetrics([], { now: FIXED_NOW }),
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

  it("renders a sleep vitals row (minutes → hours) when sleep stats exist", async () => {
    // SLEEP_DURATION stats are per-night asleep totals in MINUTES; the vitals
    // table renders them in hours. 420 min → 7 h, 450 min avg → 7.5 h.
    const data = makeData({
      stats: {
        ...makeData().stats,
        SLEEP_DURATION: {
          avg: 450,
          min: 390,
          max: 510,
          count: 7,
          latest: 420,
        },
      },
    });
    const bytes = renderDoctorReportPdfBytes(data, {
      t: getServerTranslator("en").t,
      locale: "en",
      now: FIXED_NOW,
    });
    const text = await extractText(bytes);
    // The sleep label and the hours-converted value both appear in the table.
    // `num` renders one fixed fraction digit: 420 min → 7.0 h, 450 min → 7.5 h.
    expect(text).toContain("Sleep duration");
    expect(text).toContain("7.0 h");
    expect(text).toContain("7.5 h");
    // The raw minute value must NOT leak into the table.
    expect(text).not.toContain("420 h");
    expect(text).not.toContain("450 h");
  });

  it("omits the sleep vitals row when there are no sleep stats", async () => {
    const bytes = renderDoctorReportPdfBytes(makeData(), {
      t: getServerTranslator("en").t,
      locale: "en",
      now: FIXED_NOW,
    });
    const text = await extractText(bytes);
    expect(text).not.toContain("Sleep duration");
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

// ── WinAnsi sanitiser ── the rendered Helvetica is WinAnsi-encoded; glyphs
// outside it (trend arrows, superscripts) resolve to the .notdef box at a
// fallback advance width and stretch the surrounding line. The sanitiser
// maps every offender the report can emit onto a WinAnsi-safe equivalent.
describe("sanitiseForPdf", () => {
  it("maps trend arrows to ASCII equivalents", () => {
    expect(sanitiseForPdf("↑")).toBe("^");
    expect(sanitiseForPdf("↓")).toBe("v");
    expect(sanitiseForPdf("→")).toBe("->");
  });

  it("maps the superscript-two in kg/m² to a plain 2", () => {
    expect(sanitiseForPdf("kg/m²")).toBe("kg/m2");
  });

  it("leaves WinAnsi-safe glyphs (umlauts, ß, em-dash) untouched", () => {
    expect(sanitiseForPdf("Müller — Größe")).toBe("Müller — Größe");
  });

  it("renders the GLP-1 weight summary without any non-WinAnsi glyph", async () => {
    const data = makeData({
      glp1: {
        weightStartKg: 92,
        weightEndKg: 86,
        weightDeltaKg: -6,
        medications: [],
        sideEffects: [],
      } as unknown as DoctorReportData["glp1"],
    });
    const bytes = renderDoctorReportPdfBytes(data, {
      t: getServerTranslator("de").t,
      locale: "de",
      now: FIXED_NOW,
    });
    const text = await extractText(bytes);
    // The arrow separator must have been folded to ASCII; no raw arrow in
    // the document text layer.
    expect(text).not.toMatch(/[↑↓→²]/);
    expect(text).toContain("->");
  });
});

// ── chart time axis ── the sparkline must anchor the trend in real time so a
// reader can tell whether the curve spans a week or a year.
describe("doctor-report sparkline time axis", () => {
  it("prints the series start and end dates under the chart", async () => {
    const data = makeData({
      measurements: {
        WEIGHT: [
          { value: 82, measuredAt: "2026-02-05T08:00:00.000Z" },
          { value: 81, measuredAt: "2026-03-10T08:00:00.000Z" },
          { value: 79.5, measuredAt: "2026-04-28T08:00:00.000Z" },
        ],
      },
    });
    const bytes = renderDoctorReportPdfBytes(data, {
      t: getServerTranslator("de").t,
      locale: "de",
      includeCharts: true,
      now: FIXED_NOW,
    });
    const text = await extractText(bytes);
    // dd.mm short labels (Berlin tz). First + last sample dates.
    expect(text).toContain("05.02.");
    expect(text).toContain("28.04.");
  });
});

// ── page-break discipline ── a long table must not orphan its heading or
// collide with the footer; the renderer paginates without throwing.
describe("doctor-report pagination", () => {
  it("paginates a long compliance table across pages without throwing", () => {
    const compliance: DoctorReportData["compliance"] = {};
    for (let i = 0; i < 60; i++) {
      compliance[`Medication ${i}`] = {
        total: 90,
        taken: 80,
        skipped: 5,
        missed: 5,
      };
    }
    const doc = buildDoctorReportPdfDocument(makeData({ compliance }), {
      t: getServerTranslator("de").t,
      locale: "de",
      now: FIXED_NOW,
    });
    expect(doc.getNumberOfPages()).toBeGreaterThan(1);
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

  // ── v1.4.15 phase B6 ── practice name on cover page.

  it("renders the practice name on the cover when supplied (DE)", async () => {
    const data = makeData({ practiceName: "Praxis Dr. Müller" });
    const bytes = renderDoctorReportPdfBytes(data, {
      t: getServerTranslator("de").t,
      locale: "de",
      now: FIXED_NOW,
    });
    const text = await extractText(bytes);
    expect(text).toContain("Praxis Dr. Müller");
    expect(text).toContain("Praxis:");
  });

  it("renders the practice name on the cover when supplied (EN)", async () => {
    const data = makeData({ practiceName: "Family Practice Smith & Co." });
    const bytes = renderDoctorReportPdfBytes(data, {
      t: getServerTranslator("en").t,
      locale: "en",
      now: FIXED_NOW,
    });
    const text = await extractText(bytes);
    expect(text).toContain("Family Practice Smith & Co.");
    expect(text).toContain("Practice:");
  });

  it("omits the practice line when practiceName is null", async () => {
    const data = makeData({ practiceName: null });
    const bytes = renderDoctorReportPdfBytes(data, {
      t: getServerTranslator("de").t,
      locale: "de",
      now: FIXED_NOW,
    });
    const text = await extractText(bytes);
    // Cover should NOT carry the "Praxis:" label when no name is set.
    expect(text).not.toContain("Praxis:");
  });

  it("includes the explicit period start AND end on the cover page", async () => {
    const data = makeData({
      period: {
        days: 89,
        since: "2026-02-01T00:00:00.000Z",
        start: "2026-02-01T00:00:00.000Z",
        end: "2026-04-30T00:00:00.000Z",
      },
    });
    const bytes = renderDoctorReportPdfBytes(data, {
      t: getServerTranslator("de").t,
      locale: "de",
      now: FIXED_NOW,
    });
    const text = await extractText(bytes);
    // German formatting: dd.mm.yyyy. Berlin tz on these UTC midnight
    // boundaries shifts the date by one day forward (CET = UTC+1).
    expect(text).toContain("01.02.2026");
    expect(text).toContain("30.04.2026");
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

// ── clinical glucose panel ── the server-computed TIR / GMI / eA1C panel must
// render in the PDF whenever glucose readings exist, and stay absent otherwise.
describe("doctor-report clinical glucose panel", () => {
  function denseReadings(): { measuredAt: Date; mgdl: number }[] {
    const out: { measuredAt: Date; mgdl: number }[] = [];
    for (let d = 0; d < 60; d += 1) {
      for (let h = 0; h < 24; h += 1) {
        out.push({
          measuredAt: new Date(
            FIXED_NOW.getTime() - d * 86_400_000 - h * 3_600_000,
          ),
          mgdl: 110 + ((d + h) % 7) * 8,
        });
      }
    }
    return out;
  }

  it("renders the clinical panel title + TIR/GMI rows when readings exist", async () => {
    const data = makeData({
      glucoseClinical: computeGlucoseClinicalMetrics(denseReadings(), {
        now: FIXED_NOW,
        windowDays: 90,
      }),
    });
    expect(data.glucoseClinical.readingCount).toBeGreaterThan(0);
    const bytes = renderDoctorReportPdfBytes(data, {
      t: getServerTranslator("en").t,
      locale: "en",
      now: FIXED_NOW,
    });
    const text = await extractText(bytes);
    expect(text).toContain("Glucose overview (clinical)");
    expect(text).toContain("Time in range");
    expect(text).toContain("Glucose Management Indicator");
  });

  it("omits the clinical panel when there are no glucose readings", async () => {
    const data = makeData(); // empty (zero-reading) glucose panel
    const bytes = renderDoctorReportPdfBytes(data, {
      t: getServerTranslator("en").t,
      locale: "en",
      now: FIXED_NOW,
    });
    const text = await extractText(bytes);
    expect(text).not.toContain("Glucose overview (clinical)");
  });
});

// v1.18.1 P4 — illness / condition episodes section. Retrospective + factual:
// label, type, course, onset, resolved. Present only when the aggregator
// populated `illnessEpisodes` (module on + episode in window).
describe("doctor-report illness section", () => {
  it("prints the conditions table with label, type, and dates", async () => {
    const data = makeData({
      illnessEpisodes: [
        {
          label: "Erkältung",
          type: "INFECTION",
          lifecycle: "ACUTE",
          onsetAt: "2026-04-01T00:00:00.000Z",
          resolvedAt: "2026-04-10T00:00:00.000Z",
        },
      ],
    });
    const bytes = renderDoctorReportPdfBytes(data, {
      t: getServerTranslator("en").t,
      locale: "en",
      now: FIXED_NOW,
    });
    const text = await extractText(bytes);
    expect(text).toContain("Conditions & illnesses");
    expect(text).toContain("Erkältung");
  });

  it("marks an ongoing (unresolved) episode rather than a blank cell", async () => {
    const data = makeData({
      illnessEpisodes: [
        {
          label: "Heuschnupfen",
          type: "ALLERGY",
          lifecycle: "RECURRING",
          onsetAt: "2026-04-01T00:00:00.000Z",
          resolvedAt: null,
        },
      ],
    });
    const bytes = renderDoctorReportPdfBytes(data, {
      t: getServerTranslator("en").t,
      locale: "en",
      now: FIXED_NOW,
    });
    const text = await extractText(bytes);
    expect(text).toContain("Heuschnupfen");
    expect(text).toContain("Ongoing");
  });

  it("omits the section entirely when there are no episodes", async () => {
    const bytes = renderDoctorReportPdfBytes(makeData(), {
      t: getServerTranslator("en").t,
      locale: "en",
      now: FIXED_NOW,
    });
    const text = await extractText(bytes);
    expect(text).not.toContain("Conditions & illnesses");
  });
});

describe("extracted doctor-report section boundaries", () => {
  it("header/profile prefers the legal name and renders insurance identity", async () => {
    const data = makeData({
      patient: {
        ...makeData().patient,
        fullName: "Ada Lovelace",
        username: "ignored-handle",
        insurerName: "Example Health",
      },
    });
    const bytes = renderDoctorReportPdfBytes(data, {
      t: getServerTranslator("en").t,
      locale: "en",
      now: FIXED_NOW,
      insuranceNumber: "A123456789",
    });
    const text = await extractText(bytes);
    expect(text).toContain("Ada Lovelace");
    expect(text).not.toContain("ignored-handle");
    expect(text).toContain("Example Health");
    expect(text).toContain("A123456789");
  });

  it("measurements/charts keeps the table but omits chart drawing when disabled", async () => {
    const { t } = getServerTranslator("en");
    const text = await extractText(
      renderDoctorReportPdfBytes(makeData(), {
        t,
        locale: "en",
        now: FIXED_NOW,
        includeCharts: false,
      }),
    );
    expect(text).toContain(t("doctorReport.vitalsTitle"));
    expect(text).not.toContain(t("doctorReport.chartsTitle"));
  });

  it("medications/mood/wellness omits empty optional sections", async () => {
    const { t } = getServerTranslator("en");
    const text = await extractText(
      renderDoctorReportPdfBytes(
        makeData({
          compliance: {},
          mood: null,
          wellnessScores: [],
          cycle: null,
        }),
        { t, locale: "en", now: FIXED_NOW },
      ),
    );
    expect(text).not.toContain(t("doctorReport.complianceTitle"));
    expect(text).not.toContain(t("doctorReport.moodTitle"));
    expect(text).not.toContain(t("doctorReport.wellnessTitle"));
    expect(text).not.toContain(t("doctorReport.cycleTitle"));
  });

  it("clinical records/notes ignores a whitespace-only optional summary", async () => {
    const { t } = getServerTranslator("en");
    const text = await extractText(
      renderDoctorReportPdfBytes(makeData(), {
        t,
        locale: "en",
        now: FIXED_NOW,
        aiSummary: "   \n\t ",
      }),
    );
    expect(text).not.toContain(t("doctorReport.aiSummaryTitle"));
  });

  it("footer is drawn once on every dynamically added page", async () => {
    const compliance: DoctorReportData["compliance"] = {};
    for (let i = 0; i < 60; i += 1) {
      compliance[`Medication ${i}`] = {
        total: 90,
        taken: 80,
        skipped: 5,
        missed: 5,
      };
    }
    const { t } = getServerTranslator("en");
    const data = makeData({ compliance });
    const options = { t, locale: "en" as const, now: FIXED_NOW };
    const doc = buildDoctorReportPdfDocument(data, options);
    const text = await extractText(renderDoctorReportPdfBytes(data, options));
    const footerCount =
      text.split(t("doctorReport.footerDisclaimer1")).length - 1;

    expect(doc.getNumberOfPages()).toBeGreaterThan(1);
    expect(footerCount).toBe(doc.getNumberOfPages());
  });

  it("preserves the baseline section order and exact page count", async () => {
    const { t } = getServerTranslator("en");
    const data = makeData();
    const options = { t, locale: "en" as const, now: FIXED_NOW };
    const text = await extractText(renderDoctorReportPdfBytes(data, options));
    const orderedHeadings = [
      t("doctorReport.title"),
      t("doctorReport.summaryTitle"),
      t("doctorReport.vitalsTitle"),
      t("doctorReport.chartsTitle"),
      t("doctorReport.bpClassificationTitle"),
      t("doctorReport.bmiTitle"),
      t("doctorReport.glucoseClassificationTitle"),
      t("doctorReport.complianceTitle"),
      t("doctorReport.moodTitle"),
    ];
    let previous = -1;
    for (const heading of orderedHeadings) {
      const index = text.indexOf(heading, previous + 1);
      expect(index, `missing heading: ${heading}`).toBeGreaterThan(previous);
      previous = index;
    }
    expect(buildDoctorReportPdfDocument(data, options).getNumberOfPages()).toBe(
      2,
    );
  });
});
