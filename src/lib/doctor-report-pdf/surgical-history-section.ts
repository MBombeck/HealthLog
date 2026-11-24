/**
 * The doctor report's surgical history table. Reference data (not
 * time-windowed), populated when the SURGICAL_HISTORY leaf is selected AND a
 * procedure happened. Oldest first, the order an intake form asks for it in.
 * What was done is the visit's reason; the site carries its side after it in
 * the report's language. Same calm register as the tables around it. Returns
 * the cursor below the table, or the cursor it was given when there is
 * nothing to draw.
 */
import type { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";

import type { Laterality } from "@/generated/prisma/client";
import { lateralityLabelKey } from "@/lib/encounters/kind-label";

import { PDF_FONT_FAMILY } from "./fonts";
import type { DoctorReportPdfRenderContext } from "./render-context";

export function drawSurgicalHistoryTable(
  context: DoctorReportPdfRenderContext,
  start: number,
): number {
  const { doc, data, t, fmtDate, margin, tableBottomMargin, ensureSpace } =
    context;
  let y = start;
  if (data.surgicalHistory && data.surgicalHistory.length > 0) {
    y = ensureSpace(y, 6 + 18);
    doc.setFontSize(14);
    doc.setFont(PDF_FONT_FAMILY, "bold");
    doc.setTextColor(30, 30, 30);
    doc.text(t("doctorReport.surgicalHistoryTitle"), margin, y);
    y += 6;

    const siteCell = (site: string | null, side: string | null): string => {
      if (!site) return "—";
      if (!side) return site;
      return t("encounters.bodySiteWithSide", {
        site,
        side: t(lateralityLabelKey(side as Laterality)),
      });
    };

    const procedureRows = data.surgicalHistory.map((row) => [
      fmtDate(row.occurredAt),
      row.procedure ?? "—",
      siteCell(row.bodySite, row.laterality),
      row.outcome ?? "—",
    ]);

    autoTable(doc, {
      startY: y,
      head: [
        [
          t("doctorReport.surgicalHistoryColDate"),
          t("doctorReport.surgicalHistoryColProcedure"),
          t("doctorReport.surgicalHistoryColBodySite"),
          t("doctorReport.surgicalHistoryColOutcome"),
        ],
      ],
      body: procedureRows,
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
