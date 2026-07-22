import {
  adherenceRatePercent,
  type DoctorReportData,
} from "../doctor-report-data";
import { DOCTOR_REPORT_TYPE_LABEL_KEYS } from "../doctor-report/type-label-keys";
import type {
  DoctorReportNumberFormatter,
  DoctorReportTranslator,
} from "./render-context";

export function getBmiClassificationKey(bmi: number): string {
  if (bmi < 18.5) return "doctorReport.bmiUnderweight";
  if (bmi < 25) return "doctorReport.bmiNormal";
  if (bmi < 30) return "doctorReport.bmiOverweight";
  if (bmi < 35) return "doctorReport.bmiObeseGrade1";
  if (bmi < 40) return "doctorReport.bmiObeseGrade2";
  return "doctorReport.bmiObeseGrade3";
}

export function getBpClassificationKey(sys: number, dia: number): string {
  if (sys < 120 && dia < 80) return "doctorReport.bpOptimal";
  if (sys < 130 && dia < 85) return "doctorReport.bpNormal";
  if (sys < 140 && dia < 90) return "doctorReport.bpHighNormal";
  if (sys < 160 && dia < 100) return "doctorReport.bpHypertensionGrade1";
  if (sys < 180 && dia < 110) return "doctorReport.bpHypertensionGrade2";
  return "doctorReport.bpHypertensionGrade3";
}

/** Primary vitals that get a trend sparkline + a summary trend arrow. */
export const SPARKLINE_TYPES = [
  "WEIGHT",
  "BLOOD_PRESSURE_SYS",
  "PULSE",
] as const;

/** First-half vs second-half mean → "↑" / "↓" / "→". */
export function trendArrow(values: number[]): "↑" | "↓" | "→" {
  if (values.length < 2) return "→";
  const mid = Math.floor(values.length / 2);
  const firstHalf = values.slice(0, mid);
  const secondHalf = values.slice(mid);
  const mean = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const delta = mean(secondHalf) - mean(firstHalf);
  const threshold = Math.abs(mean(firstHalf)) * 0.01;
  if (delta > threshold) return "↑";
  if (delta < -threshold) return "↓";
  return "→";
}

/** Deterministic clinical-summary lines. Pure data — no AI. */
export function buildClinicalSummaryLines(
  data: DoctorReportData,
  t: DoctorReportTranslator,
  num: DoctorReportNumberFormatter,
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

  for (const type of SPARKLINE_TYPES) {
    const series = data.measurements[type];
    const stat = data.stats[type];
    if (!series || series.length === 0 || !stat) continue;
    const arrow = trendArrow(series.map((point) => point.value));
    lines.push(
      t("doctorReport.summaryTrend", {
        label: t(DOCTOR_REPORT_TYPE_LABEL_KEYS[type] ?? ""),
        latest: num(stat.latest, 1),
        arrow,
      }),
    );
  }

  const compliance = Object.values(data.compliance);
  const totalDoses = compliance.reduce((sum, item) => sum + item.total, 0);
  const totalTaken = compliance.reduce((sum, item) => sum + item.taken, 0);
  const headlineRate = adherenceRatePercent(totalTaken, totalDoses);
  if (headlineRate !== null) {
    lines.push(
      t("doctorReport.summaryAdherence", {
        rate: num(headlineRate, 0),
      }),
    );
  }
  return lines;
}
