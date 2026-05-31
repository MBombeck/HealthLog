/**
 * Isomorphic PDF renderer for the doctor report.
 *
 * Runs identically in the browser (settings page download) and in Node
 * (server-rendered `/api/doctor-report/pdf` endpoint). All locale-sensitive
 * strings and number/date formatting are driven by the injected
 * `{ t, locale }` so DE and EN output match the user's UI language.
 *
 * jsPDF is fully isomorphic: `doc.output("arraybuffer")` returns a valid
 * `%PDF-` byte stream in both environments.
 */
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import { makeFormatters } from "./format-locale";
import type { Locale } from "./i18n/config";
import { convertGlucose, resolveGlucoseUnit } from "./glucose";
import type { DoctorReportData } from "./doctor-report-data";

type T = (key: string, params?: Record<string, string | number>) => string;

export interface DoctorReportRenderOptions {
  t: T;
  locale: Locale;
  /**
   * Optional fixed timestamp for "createdOn"/footer. Useful for deterministic
   * tests; defaults to `new Date()`.
   */
  now?: Date;
  /**
   * v1.4.25 W7 — per-user display timezone. When omitted the report
   * renders timestamps in Europe/Berlin (legacy contract). Server
   * callers pass `resolveUserTimezone(user.id)`; client callers pass
   * the value from auth context so a US user's PDF carries
   * Eastern-time rows even when generated in the browser.
   */
  userTz?: string;
  /**
   * v1.7.0 — decrypted KVNR (German insurance number). Printed on the
   * cover when present; the column is encrypted at rest, so the route
   * decrypts it and hands the plaintext in here. Null/undefined omits
   * the cover line exactly like an unset practice name.
   */
  insuranceNumber?: string | null;
  /**
   * v1.7.0 — embed jsPDF-native trend sparklines per primary vital.
   * Defaults to `true`. Off produces a compact text-only report.
   */
  includeCharts?: boolean;
  /**
   * v1.7.0 — optional AI summary text. OUT of the clinical PDF by
   * default; rendered ONLY when the user explicitly opts in, under a
   * clearly-labelled "AI summary — not clinically validated" heading.
   * Null/undefined/empty omits the section entirely.
   */
  aiSummary?: string | null;
}

/**
 * Per-vital label keys. Exported for coverage tests (issue #109 / phase P0)
 * so a future enum addition is caught by a unit test rather than reaching
 * production as a raw enum string in the PDF.
 */
export const DOCTOR_REPORT_TYPE_LABEL_KEYS: Record<string, string> = {
  WEIGHT: "doctorReport.typeWeight",
  BLOOD_PRESSURE_SYS: "doctorReport.typeBpSys",
  BLOOD_PRESSURE_DIA: "doctorReport.typeBpDia",
  PULSE: "doctorReport.typePulse",
  BODY_FAT: "doctorReport.typeBodyFat",
  SLEEP_DURATION: "doctorReport.typeSleep",
  ACTIVITY_STEPS: "doctorReport.typeSteps",
  TOTAL_BODY_WATER: "doctorReport.typeTotalBodyWater",
  BONE_MASS: "doctorReport.typeBoneMass",
  OXYGEN_SATURATION: "doctorReport.typeOxygenSaturation",
};

export const DOCTOR_REPORT_TYPE_UNIT_KEYS: Record<string, string | null> = {
  WEIGHT: "kg",
  BLOOD_PRESSURE_SYS: "mmHg",
  BLOOD_PRESSURE_DIA: "mmHg",
  PULSE: "bpm",
  BODY_FAT: "%",
  SLEEP_DURATION: "h",
  ACTIVITY_STEPS: null, // translated unit
  TOTAL_BODY_WATER: "kg",
  BONE_MASS: "kg",
  OXYGEN_SATURATION: "%",
};

/**
 * Vital types rendered in the main vitals table. Body composition
 * (TOTAL_BODY_WATER, BONE_MASS) ships alongside body fat — Withings
 * smart scales report all three together. SpO2 (Withings ScanWatch type
 * 54, HealthKit, n8n / Health Connect) is rendered last in the same
 * table for clinical readability. Glucose ships separately via
 * per-context `glucoseStats`. Sleep + activity are intentionally
 * excluded from a clinical-focused report.
 */
export const DOCTOR_REPORT_VITAL_TYPES = [
  "WEIGHT",
  "BLOOD_PRESSURE_SYS",
  "BLOOD_PRESSURE_DIA",
  "PULSE",
  "BODY_FAT",
  "TOTAL_BODY_WATER",
  "BONE_MASS",
  "OXYGEN_SATURATION",
] as const;

const MOOD_LABEL_KEYS: Record<number, string> = {
  1: "doctorReport.moodAwful",
  2: "doctorReport.moodBad",
  3: "doctorReport.moodNeutral",
  4: "doctorReport.moodGood",
  5: "doctorReport.moodGreat",
};

const GLUCOSE_LABEL_KEYS = {
  FASTING: "doctorReport.typeGlucoseFasting",
  POSTPRANDIAL: "doctorReport.typeGlucosePostprandial",
  RANDOM: "doctorReport.typeGlucoseRandom",
  BEDTIME: "doctorReport.typeGlucoseBedtime",
} as const;

const DEFAULT_GLUCOSE_RANGES = {
  FASTING: { min: 70, max: 99 },
  POSTPRANDIAL: { min: 70, max: 140 },
  RANDOM: { min: 70, max: 140 },
  BEDTIME: { min: 90, max: 150 },
} as const;

const GLUCOSE_CONTEXTS: Array<keyof typeof GLUCOSE_LABEL_KEYS> = [
  "FASTING",
  "POSTPRANDIAL",
  "RANDOM",
  "BEDTIME",
];

function getBmiClassificationKey(bmi: number): string {
  if (bmi < 18.5) return "doctorReport.bmiUnderweight";
  if (bmi < 25) return "doctorReport.bmiNormal";
  if (bmi < 30) return "doctorReport.bmiOverweight";
  if (bmi < 35) return "doctorReport.bmiObeseGrade1";
  if (bmi < 40) return "doctorReport.bmiObeseGrade2";
  return "doctorReport.bmiObeseGrade3";
}

function getBpClassificationKey(sys: number, dia: number): string {
  if (sys < 120 && dia < 80) return "doctorReport.bpOptimal";
  if (sys < 130 && dia < 85) return "doctorReport.bpNormal";
  if (sys < 140 && dia < 90) return "doctorReport.bpHighNormal";
  if (sys < 160 && dia < 100) return "doctorReport.bpHypertensionGrade1";
  if (sys < 180 && dia < 110) return "doctorReport.bpHypertensionGrade2";
  return "doctorReport.bpHypertensionGrade3";
}

/** Primary vitals that get a trend sparkline + a summary trend arrow. */
const SPARKLINE_TYPES = [
  "WEIGHT",
  "BLOOD_PRESSURE_SYS",
  "PULSE",
] as const;

type FormatNum = (value: number, decimals?: number) => string;

/** First-half vs second-half mean → "↑" / "↓" / "→". */
function trendArrow(values: number[]): "↑" | "↓" | "→" {
  if (values.length < 2) return "→";
  const mid = Math.floor(values.length / 2);
  const firstHalf = values.slice(0, mid);
  const secondHalf = values.slice(mid);
  const mean = (arr: number[]) =>
    arr.reduce((a, b) => a + b, 0) / arr.length;
  const delta = mean(secondHalf) - mean(firstHalf);
  // Threshold at ~1% of the first-half mean so flat series read "→".
  const threshold = Math.abs(mean(firstHalf)) * 0.01;
  if (delta > threshold) return "↑";
  if (delta < -threshold) return "↓";
  return "→";
}

/**
 * Deterministic clinical-summary lines. Pure data — no AI. Mirrors the
 * existing BP/BMI classification approach: factual, reproducible.
 */
function buildClinicalSummaryLines(
  data: DoctorReportData,
  t: T,
  num: FormatNum,
): string[] {
  const lines: string[] = [];

  const totalReadings = Object.values(data.measurements).reduce(
    (sum, arr) => sum + arr.length,
    0,
  );
  const paramCount = Object.keys(data.stats).length;
  if (totalReadings > 0) {
    lines.push(
      t("doctorReport.summaryReadings", {
        days: data.period.days,
        count: totalReadings,
        params: paramCount,
      }),
    );
  }

  // Per-primary-vital latest + trend arrow.
  for (const type of SPARKLINE_TYPES) {
    const series = data.measurements[type];
    const stat = data.stats[type];
    if (!series || series.length === 0 || !stat) continue;
    const arrow = trendArrow(series.map((p) => p.value));
    lines.push(
      t("doctorReport.summaryTrend", {
        label: t(DOCTOR_REPORT_TYPE_LABEL_KEYS[type] ?? ""),
        latest: num(stat.latest, 1),
        arrow,
      }),
    );
  }

  // Medication-adherence headline (weighted mean across meds).
  const compEntries = Object.values(data.compliance);
  const totalDoses = compEntries.reduce((s, c) => s + c.total, 0);
  const totalTaken = compEntries.reduce((s, c) => s + c.taken, 0);
  if (totalDoses > 0) {
    lines.push(
      t("doctorReport.summaryAdherence", {
        rate: num((totalTaken / totalDoses) * 100, 1),
      }),
    );
  }

  return lines;
}

/**
 * Draw a jsPDF-native trend sparkline (label + min/max ticks + polyline).
 * Returns the new `y` cursor below the drawn chart. Vector-only — uses
 * `doc.lines()`, no raster image, no native canvas module.
 */
function drawSparkline(
  doc: jsPDF,
  opts: {
    x: number;
    y: number;
    width: number;
    label: string;
    values: number[];
    num: FormatNum;
    unit: string;
  },
): number {
  const { x, y, width, label, values, num, unit } = opts;
  const chartHeight = 16;
  const labelHeight = 5;

  doc.setFontSize(9);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(30, 30, 30);
  doc.text(label, x, y + labelHeight - 1.5);

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  const chartTop = y + labelHeight;
  const chartBottom = chartTop + chartHeight;
  // Reserve a right gutter for the min/max value labels.
  const gutter = 22;
  const chartWidth = width - gutter;

  // Baseline box.
  doc.setDrawColor(220, 220, 220);
  doc.setLineWidth(0.2);
  doc.line(x, chartBottom, x + chartWidth, chartBottom);

  // Polyline points → jsPDF relative `lines()` deltas.
  const stepX = values.length > 1 ? chartWidth / (values.length - 1) : 0;
  const points = values.map((v, i) => ({
    px: x + i * stepX,
    py: chartBottom - ((v - min) / range) * chartHeight,
  }));
  doc.setDrawColor(80, 110, 200);
  doc.setLineWidth(0.4);
  const deltas: [number, number][] = [];
  for (let i = 1; i < points.length; i++) {
    deltas.push([points[i].px - points[i - 1].px, points[i].py - points[i - 1].py]);
  }
  if (deltas.length > 0) {
    doc.lines(deltas, points[0].px, points[0].py);
  }

  // Min/max labels in the right gutter.
  doc.setFontSize(7);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(120, 120, 120);
  const unitSuffix = unit ? ` ${unit}` : "";
  doc.text(`${num(max, 1)}${unitSuffix}`, x + chartWidth + 2, chartTop + 2);
  doc.text(`${num(min, 1)}${unitSuffix}`, x + chartWidth + 2, chartBottom);

  return chartBottom + 2;
}

/**
 * Render the doctor report into a `jsPDF` instance.
 *
 * Used internally by both the client wrapper (which calls `.save()` on the
 * returned doc) and the server renderer (which calls `.output("arraybuffer")`
 * via `renderDoctorReportPdfBytes`).
 */
export function buildDoctorReportPdfDocument(
  data: DoctorReportData,
  options: DoctorReportRenderOptions,
): jsPDF {
  const {
    t,
    locale,
    now = new Date(),
    userTz,
    insuranceNumber = null,
    includeCharts = true,
    aiSummary = null,
  } = options;
  const formatters = makeFormatters(locale, userTz);
  const num = (value: number, decimals = 1) =>
    formatters.number(value, decimals);
  const fmtDate = (iso: string) => formatters.date(iso);

  const unitFor = (type: string): string => {
    const staticUnit = DOCTOR_REPORT_TYPE_UNIT_KEYS[type];
    if (staticUnit === null && type === "ACTIVITY_STEPS") {
      return t("doctorReport.unitSteps");
    }
    return staticUnit ?? "";
  };

  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  // v1.7.0 — document metadata (PDF/A-leaning). jsPDF embeds the standard
  // Helvetica fonts and pulls no external resources; setting the document
  // properties + a deterministic creation date gives most practice systems
  // an acceptable file without the full PDF/A-1b XMP/OutputIntent work
  // (documented as a follow-up, not a release blocker).
  doc.setProperties({
    title: t("doctorReport.title"),
    subject: t("doctorReport.subtitle"),
    creator: "HealthLog",
    author: data.patient.fullName ?? data.patient.username ?? "HealthLog",
  });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 20;
  let y = margin;

  doc.setFontSize(22);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(30, 30, 30);
  doc.text(t("doctorReport.title"), margin, y);
  y += 8;

  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(100, 100, 100);
  doc.text(t("doctorReport.subtitle"), margin, y);
  y += 6;

  // Practice / clinic name on the cover. Rendered prominently above the
  // separator so the addressee is the first thing the doctor sees when
  // skimming the printout. Skipped entirely when the user did not supply
  // one — keeps the cover compact for self-archive use.
  if (data.practiceName) {
    doc.setFontSize(11);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(30, 30, 30);
    doc.text(
      `${t("doctorReport.practiceLabel")}: ${data.practiceName}`,
      margin,
      y,
    );
    y += 6;
    doc.setFont("helvetica", "normal");
  }

  doc.setDrawColor(200, 200, 200);
  doc.setLineWidth(0.5);
  doc.line(margin, y, pageWidth - margin, y);
  y += 8;

  doc.setFontSize(9);
  doc.setTextColor(80, 80, 80);
  const patientInfo: string[] = [];
  // v1.7.0 — prefer the legal full name on the cover; fall back to the
  // username when no full name is set (collapses exactly like the
  // practice name when neither is present).
  const patientName = data.patient.fullName ?? data.patient.username ?? null;
  if (patientName) {
    patientInfo.push(`${t("doctorReport.patient")}: ${patientName}`);
  }
  if (data.patient.dateOfBirth) {
    patientInfo.push(
      `${t("doctorReport.dateOfBirth")}: ${fmtDate(data.patient.dateOfBirth)}`,
    );
  }
  if (data.patient.gender) {
    const genderKeys: Record<string, string> = {
      MALE: "doctorReport.genderMale",
      FEMALE: "doctorReport.genderFemale",
    };
    const genderKey =
      genderKeys[data.patient.gender] ?? "doctorReport.genderOther";
    patientInfo.push(`${t("doctorReport.gender")}: ${t(genderKey)}`);
  }
  if (data.patient.heightCm) {
    patientInfo.push(
      `${t("doctorReport.height")}: ${data.patient.heightCm} cm`,
    );
  }
  // v1.7.0 — optional insurer + KVNR. Each line collapses when its field
  // is unset, mirroring the existing practice-name behaviour.
  if (data.patient.insurerName) {
    patientInfo.push(
      `${t("doctorReport.insurer")}: ${data.patient.insurerName}`,
    );
  }
  if (insuranceNumber) {
    patientInfo.push(
      `${t("doctorReport.insuranceNumber")}: ${insuranceNumber}`,
    );
  }
  // Reporting period uses the explicit `start`/`end` from the data payload
  // (set by `normaliseDateRange()`). For older payloads that only carried
  // `since`, fall back to (since, now()) to preserve previous behaviour.
  const periodStart = data.period.start ?? data.period.since;
  const periodEnd = data.period.end ?? now.toISOString();
  patientInfo.push(
    `${t("doctorReport.period")}: ${fmtDate(periodStart)} — ${fmtDate(periodEnd)}`,
  );
  patientInfo.push(
    `${t("doctorReport.createdOn")}: ${fmtDate(now.toISOString())}`,
  );

  for (const line of patientInfo) {
    doc.text(line, margin, y);
    y += 4.5;
  }
  y += 4;

  // v1.7.0 — deterministic clinical-summary block. Pure data (NOT AI),
  // built from the same aggregated stats the tables print. Gives a
  // physician a one-paragraph orientation before the detail tables.
  const summaryLines = buildClinicalSummaryLines(data, t, num);
  if (summaryLines.length > 0) {
    doc.setFontSize(12);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(30, 30, 30);
    doc.text(t("doctorReport.summaryTitle"), margin, y);
    y += 5;
    doc.setFontSize(9);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(60, 60, 60);
    for (const line of summaryLines) {
      const wrapped = doc.splitTextToSize(line, pageWidth - 2 * margin);
      for (const w of wrapped) {
        doc.text(w, margin, y);
        y += 4.5;
      }
    }
    y += 4;
  }

  doc.setFontSize(14);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(30, 30, 30);
  doc.text(t("doctorReport.vitalsTitle"), margin, y);
  y += 6;

  const vitalRows: string[][] = [];

  for (const type of DOCTOR_REPORT_VITAL_TYPES) {
    const s = data.stats[type];
    if (!s) continue;
    const unit = unitFor(type);
    vitalRows.push([
      t(DOCTOR_REPORT_TYPE_LABEL_KEYS[type] ?? ""),
      `${num(s.latest)} ${unit}`.trim(),
      `${num(s.avg)} ${unit}`.trim(),
      num(s.min),
      num(s.max),
      String(s.count),
    ]);
  }

  // Per-context glucose rows. Values stored canonically in mg/dL — convert to
  // the user's display unit. Reference ranges come from the server-side
  // `getEffectiveRange()` (already baked into `data.glucoseRanges`).
  const glucoseUnit = resolveGlucoseUnit(data.glucoseUnit ?? null);
  for (const ctx of GLUCOSE_CONTEXTS) {
    const s = data.glucoseStats?.[ctx];
    if (!s) continue;
    const conv = (v: number) => convertGlucose(v, glucoseUnit);
    vitalRows.push([
      t(GLUCOSE_LABEL_KEYS[ctx]),
      `${num(conv(s.latest))} ${glucoseUnit}`.trim(),
      `${num(conv(s.avg))} ${glucoseUnit}`.trim(),
      num(conv(s.min)),
      num(conv(s.max)),
      String(s.count),
    ]);
  }

  if (vitalRows.length > 0) {
    autoTable(doc, {
      startY: y,
      head: [
        [
          t("doctorReport.colParameter"),
          t("doctorReport.colCurrent"),
          t("doctorReport.colAvgPeriod"),
          t("doctorReport.colMin"),
          t("doctorReport.colMax"),
          t("doctorReport.colN"),
        ],
      ],
      body: vitalRows,
      theme: "grid",
      styles: {
        fontSize: 9,
        cellPadding: 3,
        textColor: [30, 30, 30],
        lineColor: [200, 200, 200],
        lineWidth: 0.3,
      },
      headStyles: {
        fillColor: [245, 245, 245],
        textColor: [30, 30, 30],
        fontStyle: "bold",
      },
      alternateRowStyles: { fillColor: [252, 252, 252] },
      margin: { left: margin, right: margin },
    });
    y =
      (doc as jsPDF & { lastAutoTable: { finalY: number } }).lastAutoTable
        .finalY + 8;
  }

  // v1.7.0 — jsPDF-native trend sparklines per primary vital. Vector
  // polylines drawn with `doc.lines()` — zero new dependency, no native
  // canvas module, isomorphic. Selection-gated via `includeCharts`.
  if (includeCharts) {
    const chartTypes = SPARKLINE_TYPES.filter(
      (type) => (data.measurements[type]?.length ?? 0) >= 2,
    );
    if (chartTypes.length > 0) {
      if (y > 235) {
        doc.addPage();
        y = margin;
      }
      doc.setFontSize(12);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(30, 30, 30);
      doc.text(t("doctorReport.chartsTitle"), margin, y);
      y += 6;
      for (const type of chartTypes) {
        const series = data.measurements[type] ?? [];
        if (y > 250) {
          doc.addPage();
          y = margin;
        }
        const label = t(DOCTOR_REPORT_TYPE_LABEL_KEYS[type] ?? "");
        y = drawSparkline(doc, {
          x: margin,
          y,
          width: pageWidth - 2 * margin,
          label,
          values: series.map((p) => p.value),
          num,
          unit: unitFor(type),
        });
        y += 4;
      }
      y += 2;
    }
  }

  const sysStat = data.stats.BLOOD_PRESSURE_SYS;
  const diaStat = data.stats.BLOOD_PRESSURE_DIA;
  if (sysStat && diaStat) {
    doc.setFontSize(12);
    doc.setFont("helvetica", "bold");
    doc.text(t("doctorReport.bpClassificationTitle"), margin, y);
    y += 5;

    doc.setFontSize(9);
    doc.setFont("helvetica", "normal");
    const bpClass = t(getBpClassificationKey(sysStat.avg, diaStat.avg));
    doc.text(
      `${t("doctorReport.avgBp")}: ${num(sysStat.avg, 0)}/${num(diaStat.avg, 0)} mmHg — ${t("doctorReport.classification")}: ${bpClass}`,
      margin,
      y,
    );
    y += 8;
  }

  if (data.bmi) {
    doc.setFontSize(12);
    doc.setFont("helvetica", "bold");
    doc.text(t("doctorReport.bmiTitle"), margin, y);
    y += 5;

    doc.setFontSize(9);
    doc.setFont("helvetica", "normal");
    doc.text(
      t("doctorReport.bmiRow", {
        bmi: num(data.bmi, 1),
        class: t(getBmiClassificationKey(data.bmi)),
      }),
      margin,
      y,
    );
    y += 8;
  }

  // Glucose classification — one line per logged context.
  const loggedGlucose = GLUCOSE_CONTEXTS.filter(
    (ctx) => data.glucoseStats?.[ctx],
  );
  if (loggedGlucose.length > 0) {
    if (y > 240) {
      doc.addPage();
      y = margin;
    }
    doc.setFontSize(12);
    doc.setFont("helvetica", "bold");
    doc.text(t("doctorReport.glucoseClassificationTitle"), margin, y);
    y += 5;
    doc.setFontSize(9);
    doc.setFont("helvetica", "normal");
    for (const ctx of loggedGlucose) {
      const s = data.glucoseStats[ctx];
      if (!s) continue;
      const range = data.glucoseRanges?.[ctx] ?? DEFAULT_GLUCOSE_RANGES[ctx];
      const conv = (v: number) => convertGlucose(v, glucoseUnit);
      const inRange = s.avg >= range.min && s.avg <= range.max;
      const classKey = inRange
        ? "doctorReport.glucoseInTarget"
        : s.avg < range.min
          ? "doctorReport.glucoseBelowTarget"
          : "doctorReport.glucoseAboveTarget";
      doc.text(
        t("doctorReport.glucoseRow", {
          label: t(GLUCOSE_LABEL_KEYS[ctx]),
          avg: num(conv(s.avg), 1),
          unit: glucoseUnit,
          rangeMin: num(conv(range.min)),
          rangeMax: num(conv(range.max)),
          class: t(classKey),
        }),
        margin,
        y,
      );
      y += 5;
    }
    y += 3;
  }

  const complianceEntries = Object.entries(data.compliance);
  if (complianceEntries.length > 0) {
    if (y > 240) {
      doc.addPage();
      y = margin;
    }

    doc.setFontSize(14);
    doc.setFont("helvetica", "bold");
    doc.text(t("doctorReport.complianceTitle"), margin, y);
    y += 6;

    const compRows = complianceEntries.map(([name, c]) => {
      const rate = c.total > 0 ? `${num((c.taken / c.total) * 100, 1)}%` : "—";
      return [
        name,
        String(c.taken),
        String(c.skipped),
        String(c.missed),
        String(c.total),
        rate,
      ];
    });

    autoTable(doc, {
      startY: y,
      head: [
        [
          t("doctorReport.colMedication"),
          t("doctorReport.colTaken"),
          t("doctorReport.colSkipped"),
          t("doctorReport.colMissed"),
          t("doctorReport.colTotal"),
          t("doctorReport.colComplianceRate"),
        ],
      ],
      body: compRows,
      theme: "grid",
      styles: {
        fontSize: 9,
        cellPadding: 3,
        textColor: [30, 30, 30],
        lineColor: [200, 200, 200],
        lineWidth: 0.3,
      },
      headStyles: {
        fillColor: [245, 245, 245],
        textColor: [30, 30, 30],
        fontStyle: "bold",
      },
      alternateRowStyles: { fillColor: [252, 252, 252] },
      margin: { left: margin, right: margin },
    });
    y =
      (doc as jsPDF & { lastAutoTable: { finalY: number } }).lastAutoTable
        .finalY + 8;
  }

  // v1.4.25 W4d — GLP-1 therapy section. Only renders when the data
  // aggregator emitted a non-null `glp1` block (user has at least one
  // active GLP-1 medication and the compliance toggle is on). Lists
  // current drug + dose, full titration history, weight curve over
  // the report window, side-effect frequency, and compliance %.
  if (data.glp1) {
    if (y > 220) {
      doc.addPage();
      y = margin;
    }

    doc.setFontSize(14);
    doc.setFont("helvetica", "bold");
    doc.text(t("doctorReport.glp1Title"), margin, y);
    y += 6;

    doc.setFontSize(9);
    doc.setFont("helvetica", "normal");
    if (
      data.glp1.weightDeltaKg !== null &&
      data.glp1.weightStartKg !== null &&
      data.glp1.weightEndKg !== null
    ) {
      doc.text(
        t("doctorReport.glp1WeightSummary", {
          start: num(data.glp1.weightStartKg, 1),
          end: num(data.glp1.weightEndKg, 1),
          delta: num(data.glp1.weightDeltaKg, 1),
        }),
        margin,
        y,
      );
      y += 6;
    }

    for (const med of data.glp1.medications) {
      if (y > 240) {
        doc.addPage();
        y = margin;
      }
      doc.setFontSize(11);
      doc.setFont("helvetica", "bold");
      doc.text(med.name, margin, y);
      y += 5;
      doc.setFontSize(9);
      doc.setFont("helvetica", "normal");
      if (med.currentDose) {
        doc.text(
          t("doctorReport.glp1CurrentDose", {
            value: num(med.currentDose.value, 2),
            unit: med.currentDose.unit,
            since: new Date(med.currentDose.since).toLocaleDateString(locale),
          }),
          margin,
          y,
        );
        y += 5;
      }
      if (med.compliance.total > 0) {
        const rate = (med.compliance.taken / med.compliance.total) * 100;
        doc.text(
          t("doctorReport.glp1Compliance", {
            taken: med.compliance.taken,
            total: med.compliance.total,
            rate: num(rate, 1),
          }),
          margin,
          y,
        );
        y += 5;
      }
      if (med.doseHistory.length > 0) {
        const historyRows = med.doseHistory.map((dc) => [
          new Date(dc.effectiveFrom).toLocaleDateString(locale),
          `${num(dc.value, 2)} ${dc.unit}`,
          dc.note ?? "",
        ]);
        autoTable(doc, {
          startY: y,
          head: [
            [
              t("doctorReport.colGlp1Date"),
              t("doctorReport.colGlp1Dose"),
              t("doctorReport.colGlp1Note"),
            ],
          ],
          body: historyRows,
          theme: "grid",
          styles: {
            fontSize: 9,
            cellPadding: 3,
            textColor: [30, 30, 30],
            lineColor: [200, 200, 200],
            lineWidth: 0.3,
          },
          headStyles: {
            fillColor: [245, 245, 245],
            textColor: [30, 30, 30],
            fontStyle: "bold",
          },
          alternateRowStyles: { fillColor: [252, 252, 252] },
          margin: { left: margin, right: margin },
        });
        y =
          (doc as jsPDF & { lastAutoTable: { finalY: number } }).lastAutoTable
            .finalY + 6;
      }
    }

    if (data.glp1.sideEffects.length > 0) {
      if (y > 240) {
        doc.addPage();
        y = margin;
      }
      doc.setFontSize(11);
      doc.setFont("helvetica", "bold");
      doc.text(t("doctorReport.glp1SideEffectsTitle"), margin, y);
      y += 5;
      const seRows = data.glp1.sideEffects.map((s) => [s.tag, String(s.count)]);
      autoTable(doc, {
        startY: y,
        head: [
          [t("doctorReport.colGlp1SideEffect"), t("doctorReport.colCount")],
        ],
        body: seRows,
        theme: "grid",
        styles: {
          fontSize: 9,
          cellPadding: 3,
          textColor: [30, 30, 30],
          lineColor: [200, 200, 200],
          lineWidth: 0.3,
        },
        headStyles: {
          fillColor: [245, 245, 245],
          textColor: [30, 30, 30],
          fontStyle: "bold",
        },
        alternateRowStyles: { fillColor: [252, 252, 252] },
        margin: { left: margin, right: margin },
      });
      y =
        (doc as jsPDF & { lastAutoTable: { finalY: number } }).lastAutoTable
          .finalY + 8;
    }
  }

  if (data.mood) {
    if (y > 240) {
      doc.addPage();
      y = margin;
    }

    doc.setFontSize(14);
    doc.setFont("helvetica", "bold");
    doc.text(t("doctorReport.moodTitle"), margin, y);
    y += 6;

    doc.setFontSize(9);
    doc.setFont("helvetica", "normal");
    doc.text(
      t("doctorReport.moodSummary", {
        avg: num(data.mood.avg, 1),
        count: data.mood.count,
        min: num(data.mood.min, 0),
        max: num(data.mood.max, 0),
      }),
      margin,
      y,
    );
    y += 6;

    const distRows = Object.entries(data.mood.distribution).map(
      ([score, count]) => [
        t(MOOD_LABEL_KEYS[Number(score)] ?? "doctorReport.moodNeutral"),
        String(count),
        data.mood && data.mood.count > 0
          ? `${num((count / data.mood.count) * 100, 1)}%`
          : "0%",
      ],
    );

    autoTable(doc, {
      startY: y,
      head: [
        [
          t("doctorReport.colMood"),
          t("doctorReport.colCount"),
          t("doctorReport.colShare"),
        ],
      ],
      body: distRows,
      theme: "grid",
      styles: {
        fontSize: 9,
        cellPadding: 3,
        textColor: [30, 30, 30],
        lineColor: [200, 200, 200],
        lineWidth: 0.3,
      },
      headStyles: {
        fillColor: [245, 245, 245],
        textColor: [30, 30, 30],
        fontStyle: "bold",
      },
      margin: { left: margin, right: margin },
    });
    y =
      (doc as jsPDF & { lastAutoTable: { finalY: number } }).lastAutoTable
        .finalY + 8;
  }

  // v1.7.0 — optional AI summary. OUT of the clinical PDF by default;
  // rendered ONLY when the user explicitly opted in. Clearly labelled and
  // flagged as not clinically validated so a physician never mistakes it
  // for a machine-generated diagnosis.
  const aiText = typeof aiSummary === "string" ? aiSummary.trim() : "";
  if (aiText.length > 0) {
    if (y > 220) {
      doc.addPage();
      y = margin;
    }
    doc.setFontSize(12);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(120, 80, 0);
    doc.text(t("doctorReport.aiSummaryTitle"), margin, y);
    y += 5;
    doc.setFontSize(8);
    doc.setFont("helvetica", "italic");
    doc.setTextColor(150, 110, 40);
    const disclaimer = doc.splitTextToSize(
      t("doctorReport.aiSummaryDisclaimer"),
      pageWidth - 2 * margin,
    );
    for (const line of disclaimer) {
      doc.text(line, margin, y);
      y += 4;
    }
    y += 2;
    doc.setFontSize(9);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(60, 60, 60);
    const wrapped = doc.splitTextToSize(aiText, pageWidth - 2 * margin);
    for (const line of wrapped) {
      if (y > 270) {
        doc.addPage();
        y = margin;
      }
      doc.text(line, margin, y);
      y += 4.5;
    }
    y += 4;
  }

  const addFooter = (pageDoc: jsPDF) => {
    const pageHeight = pageDoc.internal.pageSize.getHeight();
    pageDoc.setFontSize(7);
    pageDoc.setFont("helvetica", "italic");
    pageDoc.setTextColor(140, 140, 140);
    pageDoc.text(t("doctorReport.footerDisclaimer1"), margin, pageHeight - 14);
    pageDoc.text(t("doctorReport.footerDisclaimer2"), margin, pageHeight - 10);
    pageDoc.text(
      t("doctorReport.footerSource", {
        timestamp: formatters.dateTime(now),
      }),
      margin,
      pageHeight - 6,
    );
  };

  const totalPages = doc.getNumberOfPages();
  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i);
    addFooter(doc);
  }

  return doc;
}

/**
 * Render the doctor report and return the PDF as a `Uint8Array`.
 * Isomorphic — works in browser and Node.
 */
export function renderDoctorReportPdfBytes(
  data: DoctorReportData,
  options: DoctorReportRenderOptions,
): Uint8Array {
  const doc = buildDoctorReportPdfDocument(data, options);
  const ab = doc.output("arraybuffer");
  return new Uint8Array(ab);
}
