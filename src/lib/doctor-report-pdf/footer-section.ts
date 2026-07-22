import type { jsPDF } from "jspdf";
import {
  pdfCursorState,
  type DoctorReportPdfCursorState,
  type DoctorReportPdfRenderContext,
} from "./render-context";

export function buildReportFooter(
  context: DoctorReportPdfRenderContext,
  state: DoctorReportPdfCursorState,
): DoctorReportPdfCursorState {
  const { doc, t, margin, footerTz, dateTime, now } = context;

  const addFooter = (pageDoc: jsPDF) => {
    const pageHeight = pageDoc.internal.pageSize.getHeight();
    pageDoc.setFontSize(7);
    pageDoc.setFont("helvetica", "italic");
    pageDoc.setTextColor(140, 140, 140);
    pageDoc.text(t("doctorReport.footerDisclaimer1"), margin, pageHeight - 14);
    pageDoc.text(t("doctorReport.footerDisclaimer2"), margin, pageHeight - 10);
    pageDoc.text(
      t("doctorReport.footerSource", {
        timezone: footerTz,
        timestamp: dateTime(now),
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

  return pdfCursorState(doc, state.y);
}
