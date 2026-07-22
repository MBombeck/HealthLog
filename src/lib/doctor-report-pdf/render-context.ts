import type { jsPDF } from "jspdf";
import type { DoctorReportData } from "../doctor-report-data";

export type DoctorReportTranslator = (
  key: string,
  params?: Record<string, string | number>,
) => string;

export type DoctorReportNumberFormatter = (
  value: number,
  decimals?: number,
) => string;

export interface DoctorReportPdfCursorState {
  y: number;
  pageNumber: number;
}

export interface DoctorReportPdfRenderContext {
  doc: jsPDF;
  data: DoctorReportData;
  t: DoctorReportTranslator;
  num: DoctorReportNumberFormatter;
  fmtDate: (iso: string) => string;
  dateShort: (iso: string) => string;
  dateTime: (date: Date) => string;
  now: Date;
  insuranceNumber: string | null;
  includeCharts: boolean;
  aiSummary: string | null;
  footerTz: string;
  margin: number;
  pageWidth: number;
  pageHeight: number;
  contentMaxY: number;
  tableBottomMargin: number;
  vitalTypes: readonly string[];
  unitFor: (type: string) => string;
  ensureSpace: (current: number, needed: number) => number;
}

export function pdfCursorState(
  doc: jsPDF,
  y: number,
): DoctorReportPdfCursorState {
  return { y, pageNumber: doc.getNumberOfPages() };
}
