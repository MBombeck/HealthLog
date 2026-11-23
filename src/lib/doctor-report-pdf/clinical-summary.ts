import {
  adherenceRatePercent,
  type DoctorReportData,
} from "../doctor-report-data";
import type { MeasurementType } from "@/generated/prisma/client";
import { reportMeasurementLabelKey } from "../report-selection/catalogue";
import type {
  DoctorReportNumberFormatter,
  DoctorReportTranslator,
} from "./render-context";
import { dayValueRows } from "@/lib/measurements/day-mean";
import { mean } from "@/lib/stats/central";
import {
  bmiCategory,
  bpCategory,
  type BmiCategory,
  type BpCategory,
} from "@/lib/analytics/classifications";

const BMI_KEYS: Record<BmiCategory, string> = {
  underweight: "doctorReport.bmiUnderweight",
  normal: "doctorReport.bmiNormal",
  overweight: "doctorReport.bmiOverweight",
  obese1: "doctorReport.bmiObeseGrade1",
  obese2: "doctorReport.bmiObeseGrade2",
  obese3: "doctorReport.bmiObeseGrade3",
};

const BP_KEYS: Record<BpCategory, string> = {
  optimal: "doctorReport.bpOptimal",
  normal: "doctorReport.bpNormal",
  highNormal: "doctorReport.bpHighNormal",
  grade1: "doctorReport.bpHypertensionGrade1",
  grade2: "doctorReport.bpHypertensionGrade2",
  grade3: "doctorReport.bpHypertensionGrade3",
};

export function getBmiClassificationKey(bmi: number): string {
  return BMI_KEYS[bmiCategory(bmi)];
}

export function getBpClassificationKey(sys: number, dia: number): string {
  return BP_KEYS[bpCategory(sys, dia)];
}

/** Primary vitals that get a trend sparkline + a summary trend arrow. */
export const SPARKLINE_TYPES = [
  "WEIGHT",
  "BLOOD_PRESSURE_SYS",
  "PULSE",
] as const;

/**
 * The wearable series charted at half width, two to a row, below the
 * full-width vitals. Each still needs its leaf selected and two points in the
 * window. The points are the report's own series: one per night for sleep,
 * day buckets for heart-rate variability once the window or the row count
 * passes the raw limit, and the daily totals steps arrive as.
 */
export const COMPACT_SPARKLINE_TYPES = [
  "SLEEP_DURATION",
  "HEART_RATE_VARIABILITY",
  "HRV_RMSSD",
  "ACTIVITY_STEPS",
] as const satisfies readonly MeasurementType[];

/** First-half vs second-half mean → "↑" / "↓" / "→". */
export function trendArrow(values: number[]): "↑" | "↓" | "→" {
  if (values.length < 2) return "→";
  const mid = Math.floor(values.length / 2);
  const firstHalf = values.slice(0, mid);
  const secondHalf = values.slice(mid);
  // Both halves hold at least one value once there are two.
  const delta = mean(secondHalf)! - mean(firstHalf)!;
  const threshold = Math.abs(mean(firstHalf)!) * 0.01;
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
  // The reading count, not the point count: a dense type served from day
  // buckets draws one point per day, but its stats count every reading.
  const totalReadings = Object.entries(data.measurements).reduce(
    (sum, [type, arr]) => sum + (data.stats[type]?.count ?? arr.length),
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
    // A pulse series on the raw path holds every reading, so halves of it
    // are halves by reading count and a dense workout hour tips the arrow.
    // Compare day values instead, each the mean of its hours' means (see
    // `day-mean.ts`); the report's day points already are one per day. Days
    // are UTC days: the arrow needs only their order. Every other type keeps
    // its points as they are.
    const arrow = trendArrow(
      dayValueRows(
        type,
        series.map((point) => ({
          value: point.value,
          measuredAt: new Date(point.measuredAt),
        })),
        "UTC",
      ).map((point) => point.value),
    );
    lines.push(
      t("doctorReport.summaryTrend", {
        label: t(reportMeasurementLabelKey(type as MeasurementType)),
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
