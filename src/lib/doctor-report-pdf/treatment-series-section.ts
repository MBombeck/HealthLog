/**
 * The doctor report's treatment-series table: the series the window touched,
 * drawn under the visits they are made of, on the VISITS leaf. Same calm
 * register as the tables around it; the counts and the status come resolved
 * from the aggregator. Returns the cursor below the table, or the cursor it
 * was given when there is nothing to draw.
 */
import type { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";

import {
  seriesPeriodCell,
  seriesSessionsCell,
} from "@/lib/treatment-series/report-lines";

import { PDF_FONT_FAMILY } from "./fonts";
import type { DoctorReportPdfRenderContext } from "./render-context";

export function drawTreatmentSeriesTable(
  context: DoctorReportPdfRenderContext,
  start: number,
): number {
  const { doc, data, t, fmtDate, margin, tableBottomMargin, ensureSpace } =
    context;
  let y = start;
  if (data.treatmentSeries && data.treatmentSeries.length > 0) {
    y = ensureSpace(y, 6 + 18);
    doc.setFontSize(14);
    doc.setFont(PDF_FONT_FAMILY, "bold");
    doc.setTextColor(30, 30, 30);
    doc.text(t("treatmentSeries.reportTitle"), margin, y);
    y += 6;

    const seriesRows = data.treatmentSeries.map((row) => [
      row.title ?? "—",
      seriesSessionsCell(t, row),
      seriesPeriodCell(t, row, fmtDate),
      row.prescriberName ?? "—",
      row.performerName ?? "—",
      row.conditionLabel ?? "—",
    ]);

    autoTable(doc, {
      startY: y,
      head: [
        [
          t("treatmentSeries.reportColSeries"),
          t("treatmentSeries.reportColSessions"),
          t("treatmentSeries.reportColPeriod"),
          t("treatmentSeries.prescriber"),
          t("treatmentSeries.performer"),
          t("treatmentSeries.condition"),
        ],
      ],
      body: seriesRows,
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
      margin: {
        left: margin,
        right: margin,
        top: margin,
        bottom: tableBottomMargin,
      },
    });
    y =
      (doc as jsPDF & { lastAutoTable: { finalY: number } }).lastAutoTable
        .finalY + 8;
  }
  return y;
}
