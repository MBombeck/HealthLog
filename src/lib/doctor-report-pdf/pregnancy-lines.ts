/**
 * The pregnancy lines of the doctor report's cycle section (v1.49).
 *
 * What the owner recorded and the count on the report date: the state, the
 * first day, the due date, the week (completed weeks and days), or the
 * delivery date and the week since. Nothing about what a week means.
 */
import type { CycleExportPregnancy } from "@/lib/cycle/export-data";

import { PDF_FONT_FAMILY } from "./fonts";
import type { DoctorReportPdfRenderContext } from "./render-context";

type Translate = (
  key: string,
  vars?: Record<string, string | number>,
) => string;

/**
 * `fmtCalendarDate` formats the day key as the calendar date it is. Read as
 * an instant at noon UTC in the report zone, it moved to the next day in
 * zones at UTC+13 and +14.
 */
export function pregnancyReportLines(
  pregnancy: CycleExportPregnancy,
  t: Translate,
  fmtCalendarDate: (dayKey: string) => string,
): string[] {
  const day = fmtCalendarDate;
  const lines: string[] = [];
  if (pregnancy.state === "PREGNANT") {
    lines.push(
      pregnancy.gestationalWeeks !== null
        ? t("doctorReport.pregnancy.pregnantWeek", {
            weeks: pregnancy.gestationalWeeks,
            days: pregnancy.gestationalDays ?? 0,
          })
        : t("doctorReport.pregnancy.pregnant"),
    );
    if (pregnancy.startDate) {
      lines.push(
        `${t("doctorReport.pregnancy.startDate")}: ${day(pregnancy.startDate)}`,
      );
    }
    if (pregnancy.dueDate) {
      lines.push(
        `${t("doctorReport.pregnancy.dueDate")}: ${day(pregnancy.dueDate)}`,
      );
    }
  } else {
    lines.push(
      t("doctorReport.pregnancy.postpartumWeek", {
        weeks: pregnancy.postpartumWeek ?? 0,
      }),
    );
    if (pregnancy.deliveryDate) {
      lines.push(
        `${t("doctorReport.pregnancy.deliveryDate")}: ${day(pregnancy.deliveryDate)}`,
      );
    }
  }
  lines.push(t("doctorReport.pregnancy.predictionsPaused"));
  return lines;
}

/** Draw the pregnancy block under the cycle summary; returns the new y. */
export function drawPregnancyBlock(
  context: Pick<
    DoctorReportPdfRenderContext,
    "doc" | "t" | "fmtCalendarDate" | "margin" | "ensureSpace"
  >,
  pregnancy: CycleExportPregnancy | null | undefined,
  y: number,
): number {
  if (!pregnancy) return y;
  const { doc, t, fmtCalendarDate, margin, ensureSpace } = context;
  doc.setFont(PDF_FONT_FAMILY, "bold");
  doc.text(t("doctorReport.pregnancy.title"), margin, y);
  let cursor = y + 4.5;
  doc.setFont(PDF_FONT_FAMILY, "normal");
  for (const line of pregnancyReportLines(pregnancy, t, fmtCalendarDate)) {
    cursor = ensureSpace(cursor, 4.5);
    doc.text(line, margin, cursor);
    cursor += 4.5;
  }
  return cursor + 2;
}
