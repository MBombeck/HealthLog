/**
 * Two compact PDF blocks added with the v1.44 report: the per-sport workout
 * summary and the medication effect around each start.
 *
 * Both render only what the aggregator handed over (the selection and the
 * modules are applied there), and both are tables of a few rows: a workout
 * block is one row per sport, never a session log, and the effect block is
 * one row per medication and target with its caveats as short notes under it.
 */
import type { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import { PDF_FONT_FAMILY } from "./fonts";
import { dateOnlyAtNoonUtc } from "@/lib/tz/date-only";
import type { MeasurementType } from "@/generated/prisma/client";
import { formatEstimate } from "@/lib/medications/efficacy/segmented-format";
import type { EfficacySegmented } from "@/lib/medications/efficacy/segmented-effect";
import { reportMeasurementLabelKey } from "../report-selection/catalogue";
import { reportSportLabel } from "../doctor-report/sport-label";
import {
  pdfCursorState,
  type DoctorReportPdfCursorState,
  type DoctorReportPdfRenderContext,
} from "./render-context";

const TABLE_STYLES = {
  theme: "grid" as const,
  styles: {
    fontSize: 8.5,
    cellPadding: 2.2,
    textColor: [30, 30, 30] as [number, number, number],
    lineColor: [200, 200, 200] as [number, number, number],
    lineWidth: 0.3,
  },
  headStyles: {
    fillColor: [245, 245, 245] as [number, number, number],
    textColor: [30, 30, 30] as [number, number, number],
    fontStyle: "bold" as const,
  },
  alternateRowStyles: {
    fillColor: [252, 252, 252] as [number, number, number],
  },
};

function lastTableY(doc: jsPDF): number {
  return (doc as jsPDF & { lastAutoTable: { finalY: number } }).lastAutoTable
    .finalY;
}

function heading(
  context: DoctorReportPdfRenderContext,
  y: number,
  text: string,
  keepWith: number,
): number {
  const { doc, margin, ensureSpace } = context;
  const top = ensureSpace(y, 6 + keepWith);
  doc.setFontSize(12);
  doc.setFont(PDF_FONT_FAMILY, "bold");
  doc.setTextColor(30, 30, 30);
  doc.text(text, margin, top);
  return top + 5;
}

function note(
  context: DoctorReportPdfRenderContext,
  y: number,
  text: string,
): number {
  const { doc, margin, pageWidth, ensureSpace } = context;
  doc.setFontSize(8);
  doc.setFont(PDF_FONT_FAMILY, "normal");
  doc.setTextColor(90, 90, 90);
  let cursor = y;
  for (const line of doc.splitTextToSize(text, pageWidth - 2 * margin)) {
    cursor = ensureSpace(cursor, 4);
    doc.text(line, margin, cursor);
    cursor += 3.8;
  }
  doc.setTextColor(30, 30, 30);
  return cursor;
}

/** The per-sport workout summary. */
export function buildWorkoutsSection(
  context: DoctorReportPdfRenderContext,
  state: DoctorReportPdfCursorState,
): DoctorReportPdfCursorState {
  const { doc, data, t, num, margin, tableBottomMargin } = context;
  const w = data.workouts;
  if (!w || w.sessions === 0) return state;

  let y = heading(context, state.y, t("doctorReport.workouts.title"), 24);
  y = note(
    context,
    y,
    t("doctorReport.workouts.summary", {
      sessions: w.sessions,
      hours: num(w.totalDurationSec / 3600, 1),
      perWeek: num(w.sessionsPerWeek, 1),
      minutesPerWeek: num(w.minutesPerWeek, 0),
    }),
  );
  y += 1;

  autoTable(doc, {
    startY: y,
    head: [
      [
        t("doctorReport.workouts.colSport"),
        t("doctorReport.workouts.colSessions"),
        t("doctorReport.workouts.colTime"),
        t("doctorReport.workouts.colDistance"),
        t("doctorReport.workouts.colEnergy"),
        t("doctorReport.workouts.colHeartRate"),
      ],
    ],
    body: w.bySport.map((s) => [
      reportSportLabel(t, s.sportType),
      String(s.sessions),
      `${num(s.durationSec / 3600, 1)} h`,
      s.distanceM !== null
        ? s.distanceSessions < s.sessions
          ? `${num(s.distanceM / 1000, 1)} km (${s.distanceSessions}/${s.sessions})`
          : `${num(s.distanceM / 1000, 1)} km`
        : "",
      s.energyKcal !== null ? `${num(s.energyKcal, 0)} kcal` : "",
      s.avgHeartRate !== null ? `${num(s.avgHeartRate, 0)} bpm` : "",
    ]),
    ...TABLE_STYLES,
    margin: {
      left: margin,
      right: margin,
      top: margin,
      bottom: tableBottomMargin,
    },
  });
  y = lastTableY(doc) + 3;
  if (w.sportCount > w.bySport.length) {
    y = note(
      context,
      y,
      t("doctorReport.workouts.moreSports", {
        count: w.sportCount - w.bySport.length,
      }),
    );
  }
  return pdfCursorState(doc, y + 5);
}

const EFFECT_REASON_KEYS: Record<
  NonNullable<EfficacySegmented["reason"]>,
  string
> = {
  no_start: "doctorReport.medicationEffect.reasonNoStart",
  insufficient_before: "doctorReport.medicationEffect.reasonBefore",
  insufficient_after: "doctorReport.medicationEffect.reasonAfter",
  fit_failed: "doctorReport.medicationEffect.reasonFit",
};

const CONFOUNDER_KEYS = {
  started: "medications.efficacy.segmented.confounderStarted",
  stopped: "medications.efficacy.segmented.confounderStopped",
  dose_change: "medications.efficacy.segmented.confounderDoseChange",
  paused: "medications.efficacy.segmented.confounderPaused",
  resumed: "medications.efficacy.segmented.confounderResumed",
} as const;

/** A stated calendar day printed in the report's date order. */
function dayLabel(
  fmtDate: DoctorReportPdfRenderContext["fmtDate"],
  day: string,
): string {
  return fmtDate(dateOnlyAtNoonUtc(day).toISOString());
}

/** The segmented-regression effect, one row per medication and target. */
export function buildMedicationEffectSection(
  context: DoctorReportPdfRenderContext,
  state: DoctorReportPdfCursorState,
): DoctorReportPdfCursorState {
  const { doc, data, t, num, fmtDate, margin, tableBottomMargin, unitFor } =
    context;
  const effects = data.medicationEffects;
  if (!effects || effects.length === 0) return state;

  const numAt = (v: number, d: number) => num(v, d);
  const rows: string[][] = [];
  const notes: string[] = [];
  for (const med of effects) {
    for (const target of med.targets) {
      const e = target.effect;
      const label = t(
        reportMeasurementLabelKey(target.type as MeasurementType),
      );
      const unit = unitFor(target.type);
      const name = `${med.medicationName}\n${label}`;
      const start = med.startsOn ? dayLabel(fmtDate, med.startsOn) : "";
      if (!e.present || !e.levelChange || !e.slopeChangePerWeek || !e.window) {
        rows.push([
          name,
          start,
          t(EFFECT_REASON_KEYS[e.reason ?? "fit_failed"]),
          "",
          "",
        ]);
        continue;
      }
      const level = formatEstimate(e.levelChange, numAt);
      const slope = formatEstimate(e.slopeChangePerWeek, numAt);
      rows.push([
        name,
        start,
        `${level.value} ${unit}\n(${level.low} ${t("doctorReport.medicationEffect.to")} ${level.high})`,
        `${slope.value} ${unit}/${t("doctorReport.medicationEffect.week")}\n(${slope.low} ${t("doctorReport.medicationEffect.to")} ${slope.high})`,
        `${e.days.before} / ${e.days.after}`,
      ]);
      // The fitted window reaches up to 90 days before the start and 180
      // after it, so it can lie partly outside the report period: always
      // say which days the figures rest on.
      const extras: string[] = [
        t("doctorReport.medicationEffect.window", {
          from: dayLabel(fmtDate, e.window.from),
          to: dayLabel(fmtDate, e.window.to),
        }),
      ];
      if (e.days.excludedLowAdherence > 0) {
        extras.push(
          t("doctorReport.medicationEffect.excludedAdherence", {
            count: e.days.excludedLowAdherence,
            floor: e.adherence.floorPct,
          }),
        );
      }
      if (e.days.excludedNotTaking > 0) {
        extras.push(
          t("doctorReport.medicationEffect.excludedNotTaking", {
            count: e.days.excludedNotTaking,
          }),
        );
      }
      if (e.adherence.status === "not_tracked") {
        extras.push(t("doctorReport.medicationEffect.notTracked"));
      }
      if (e.fit?.autocorrelationCaveat) {
        extras.push(t("doctorReport.medicationEffect.autocorrelation"));
      }
      if (e.window.endReason === "dose_change") {
        extras.push(
          t("doctorReport.medicationEffect.endDoseChange", {
            date: dayLabel(fmtDate, e.window.to),
          }),
        );
      }
      for (const c of e.confounders) {
        extras.push(
          t(CONFOUNDER_KEYS[c.event], {
            name: c.medicationName,
            date: dayLabel(fmtDate, c.date),
          }),
        );
      }
      notes.push(`${med.medicationName}, ${label}: ${extras.join("; ")}.`);
    }
  }
  if (rows.length === 0) return state;

  let y = heading(
    context,
    state.y,
    t("doctorReport.medicationEffect.title"),
    24,
  );
  autoTable(doc, {
    startY: y,
    head: [
      [
        t("doctorReport.medicationEffect.colMedication"),
        t("doctorReport.medicationEffect.colStart"),
        t("doctorReport.medicationEffect.colLevel"),
        t("doctorReport.medicationEffect.colSlope"),
        t("doctorReport.medicationEffect.colDays"),
      ],
    ],
    body: rows,
    ...TABLE_STYLES,
    margin: {
      left: margin,
      right: margin,
      top: margin,
      bottom: tableBottomMargin,
    },
  });
  y = lastTableY(doc) + 3;
  for (const line of notes) y = note(context, y, line);
  y = note(context, y + 1, t("doctorReport.medicationEffect.method"));
  return pdfCursorState(doc, y + 5);
}
