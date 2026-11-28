/**
 * The doctor report's imaging table (#1672). Reference data (not
 * time-windowed), populated when the IMAGING_EXAMS leaf is selected AND the
 * `imaging` module is on AND an exam exists. Oldest first, like the surgical
 * history above it. The exam is the modality with the body part and side;
 * the conclusion is the person's own words, never an interpretation. Returns
 * the cursor below the table, or the cursor it was given when there is
 * nothing to draw.
 */
import type { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";

import { PDF_FONT_FAMILY } from "./fonts";
import type { DoctorReportPdfRenderContext } from "./render-context";

export function drawImagingTable(
  context: DoctorReportPdfRenderContext,
  start: number,
): number {
  const {
    doc,
    data,
    t,
    fmtCalendarDate,
    margin,
    tableBottomMargin,
    ensureSpace,
  } = context;
  let y = start;
  const exams = data.imagingExams;
  if (!exams || exams.length === 0) return y;

  y = ensureSpace(y, 6 + 18);
  doc.setFontSize(14);
  doc.setFont(PDF_FONT_FAMILY, "bold");
  doc.setTextColor(30, 30, 30);
  doc.text(t("doctorReport.imagingTitle"), margin, y);
  y += 6;

  const rows = exams.map((row) => [
    fmtCalendarDate(row.performedAt),
    [
      t(`imaging.modality.${row.modality}`),
      row.bodyPart,
      row.side ? t(`imaging.side.${row.side}`) : null,
    ]
      .filter(Boolean)
      .join(", "),
    [row.facility, row.requestingDoctor].filter(Boolean).join(", ") || "—",
    row.conclusion ?? "—",
  ]);

  autoTable(doc, {
    startY: y,
    head: [
      [
        t("doctorReport.imagingColDate"),
        t("doctorReport.imagingColExam"),
        t("doctorReport.imagingColFacility"),
        t("doctorReport.imagingColConclusion"),
      ],
    ],
    body: rows,
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
  return (
    (doc as jsPDF & { lastAutoTable: { finalY: number } }).lastAutoTable
      .finalY + 8
  );
}
