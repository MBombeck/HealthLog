/**
 * Client-side PDF generation for doctor reports.
 *
 * Every string and every number/date is driven by an injected `t()` and
 * locale-aware formatters so the exported PDF matches the user's UI language.
 * Call sites must pass `{ t, locale }` (use the ones from `useTranslations()`
 * / `useFormatters()`).
 */
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import { makeFormatters } from "./format-locale";
import type { Locale } from "./i18n/config";
import { convertGlucose, resolveGlucoseUnit } from "./glucose";

interface ReportData {
  period: { days: number; since: string };
  patient: {
    username: string | null;
    dateOfBirth: string | null;
    gender: string | null;
    heightCm: number | null;
  };
  stats: Record<
    string,
    { avg: number; min: number; max: number; count: number; latest: number }
  >;
  /** Per-context glucose stats (canonical mg/dL). */
  glucoseStats?: Record<
    "FASTING" | "POSTPRANDIAL" | "RANDOM" | "BEDTIME",
    | { avg: number; min: number; max: number; count: number; latest: number }
    | undefined
  >;
  /** Display-unit preference: "mg/dL" (default) or "mmol/L". */
  glucoseUnit?: "mg/dL" | "mmol/L";
  /** Per-context custom range (canonical mg/dL); fall back to defaults. */
  glucoseRanges?: Record<
    "FASTING" | "POSTPRANDIAL" | "RANDOM" | "BEDTIME",
    { min: number; max: number } | undefined
  >;
  bmi: number | null;
  compliance: Record<
    string,
    { total: number; taken: number; skipped: number; missed: number }
  >;
  medications: Array<{
    name: string;
    dose: string;
    schedules: Array<{
      windowStart: string;
      windowEnd: string;
      label: string | null;
    }>;
  }>;
  mood: {
    avg: number;
    min: number;
    max: number;
    count: number;
    distribution: Record<number, number>;
  } | null;
}

type T = (key: string, params?: Record<string, string | number>) => string;

export interface DoctorReportOptions {
  t: T;
  locale: Locale;
}

const TYPE_LABEL_KEYS: Record<string, string> = {
  WEIGHT: "doctorReport.typeWeight",
  BLOOD_PRESSURE_SYS: "doctorReport.typeBpSys",
  BLOOD_PRESSURE_DIA: "doctorReport.typeBpDia",
  PULSE: "doctorReport.typePulse",
  BODY_FAT: "doctorReport.typeBodyFat",
  SLEEP_DURATION: "doctorReport.typeSleep",
  ACTIVITY_STEPS: "doctorReport.typeSteps",
  TOTAL_BODY_WATER: "doctorReport.typeTotalBodyWater",
  BONE_MASS: "doctorReport.typeBoneMass",
};

const TYPE_UNIT_KEYS: Record<string, string | null> = {
  WEIGHT: "kg",
  BLOOD_PRESSURE_SYS: "mmHg",
  BLOOD_PRESSURE_DIA: "mmHg",
  PULSE: "bpm",
  BODY_FAT: "%",
  SLEEP_DURATION: "h",
  ACTIVITY_STEPS: null, // translated unit
  TOTAL_BODY_WATER: "kg",
  BONE_MASS: "kg",
};

const MOOD_LABEL_KEYS: Record<number, string> = {
  1: "doctorReport.moodAwful",
  2: "doctorReport.moodBad",
  3: "doctorReport.moodNeutral",
  4: "doctorReport.moodGood",
  5: "doctorReport.moodGreat",
};

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

export function generateDoctorReportPDF(
  data: ReportData,
  options: DoctorReportOptions,
): jsPDF {
  const { t, locale } = options;
  const formatters = makeFormatters(locale);
  const num = (value: number, decimals = 1) =>
    formatters.number(value, decimals);
  const fmtDate = (iso: string) => formatters.date(iso);

  const unitFor = (type: string): string => {
    // Map entry === null means the unit needs translation (e.g. ACTIVITY_STEPS).
    const staticUnit = TYPE_UNIT_KEYS[type];
    if (staticUnit === null && type === "ACTIVITY_STEPS") {
      return t("doctorReport.unitSteps");
    }
    return staticUnit ?? "";
  };

  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
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

  doc.setDrawColor(200, 200, 200);
  doc.setLineWidth(0.5);
  doc.line(margin, y, pageWidth - margin, y);
  y += 8;

  doc.setFontSize(9);
  doc.setTextColor(80, 80, 80);
  const patientInfo: string[] = [];
  if (data.patient.username) {
    patientInfo.push(`${t("doctorReport.patient")}: ${data.patient.username}`);
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
  patientInfo.push(
    `${t("doctorReport.period")}: ${fmtDate(data.period.since)} — ${fmtDate(new Date().toISOString())}`,
  );
  patientInfo.push(
    `${t("doctorReport.createdOn")}: ${fmtDate(new Date().toISOString())}`,
  );

  for (const line of patientInfo) {
    doc.text(line, margin, y);
    y += 4.5;
  }
  y += 4;

  doc.setFontSize(14);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(30, 30, 30);
  doc.text(t("doctorReport.vitalsTitle"), margin, y);
  y += 6;

  const vitalRows: string[][] = [];
  const vitalTypes = [
    "WEIGHT",
    "BLOOD_PRESSURE_SYS",
    "BLOOD_PRESSURE_DIA",
    "PULSE",
    "BODY_FAT",
    "TOTAL_BODY_WATER",
    "BONE_MASS",
  ];

  for (const type of vitalTypes) {
    const s = data.stats[type];
    if (!s) continue;
    const unit = unitFor(type);
    vitalRows.push([
      t(TYPE_LABEL_KEYS[type] ?? ""),
      `${num(s.latest)} ${unit}`.trim(),
      `${num(s.avg)} ${unit}`.trim(),
      num(s.min),
      num(s.max),
      String(s.count),
    ]);
  }

  // Per-context glucose rows (one per logged context). Values stored
  // canonically in mg/dL — convert to the user's display unit. Reference
  // ranges come from getEffectiveRange() server-side via data.glucoseRanges,
  // falling back to ADA defaults below.
  const glucoseUnit = resolveGlucoseUnit(data.glucoseUnit ?? null);
  const glucoseLabelKeys = {
    FASTING: "doctorReport.typeGlucoseFasting",
    POSTPRANDIAL: "doctorReport.typeGlucosePostprandial",
    RANDOM: "doctorReport.typeGlucoseRandom",
    BEDTIME: "doctorReport.typeGlucoseBedtime",
  } as const;
  const defaultGlucoseRanges = {
    FASTING: { min: 70, max: 99 },
    POSTPRANDIAL: { min: 70, max: 140 },
    RANDOM: { min: 70, max: 140 },
    BEDTIME: { min: 90, max: 150 },
  } as const;
  const glucoseContexts: Array<keyof typeof glucoseLabelKeys> = [
    "FASTING",
    "POSTPRANDIAL",
    "RANDOM",
    "BEDTIME",
  ];
  for (const ctx of glucoseContexts) {
    const s = data.glucoseStats?.[ctx];
    if (!s) continue;
    const conv = (v: number) => convertGlucose(v, glucoseUnit);
    vitalRows.push([
      t(glucoseLabelKeys[ctx]),
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

  // Glucose classification block — one line per logged context with the
  // reference range and an in/out classification. Range source: server-side
  // getEffectiveRange() (data.glucoseRanges). Falls back to ADA defaults.
  const loggedGlucose = glucoseContexts.filter(
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
      const s = data.glucoseStats![ctx]!;
      const range = data.glucoseRanges?.[ctx] ?? defaultGlucoseRanges[ctx];
      const conv = (v: number) => convertGlucose(v, glucoseUnit);
      const inRange = s.avg >= range.min && s.avg <= range.max;
      const classKey = inRange
        ? "doctorReport.glucoseInTarget"
        : s.avg < range.min
          ? "doctorReport.glucoseBelowTarget"
          : "doctorReport.glucoseAboveTarget";
      doc.text(
        t("doctorReport.glucoseRow", {
          label: t(glucoseLabelKeys[ctx]),
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
        data.mood!.count > 0
          ? `${num((count / data.mood!.count) * 100, 1)}%`
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

  const addFooter = (pageDoc: jsPDF) => {
    const pageHeight = pageDoc.internal.pageSize.getHeight();
    pageDoc.setFontSize(7);
    pageDoc.setFont("helvetica", "italic");
    pageDoc.setTextColor(140, 140, 140);
    pageDoc.text(t("doctorReport.footerDisclaimer1"), margin, pageHeight - 14);
    pageDoc.text(t("doctorReport.footerDisclaimer2"), margin, pageHeight - 10);
    pageDoc.text(
      t("doctorReport.footerSource", {
        timestamp: formatters.dateTime(new Date()),
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
