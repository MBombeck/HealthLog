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
  /**
   * A date-only value (a date of birth, a dose date): its calendar date, the
   * same in every zone. `fmtDate` reads an instant in the report zone, which
   * put a UTC-midnight date on the previous day west of UTC.
   */
  fmtCalendarDate: (iso: string) => string;
  dateShort: (iso: string) => string;
  dateTime: (date: Date) => string;
  now: Date;
  insuranceNumber: string | null;
  includeCharts: boolean;
  footerTz: string;
  margin: number;
  pageWidth: number;
  pageHeight: number;
  contentMaxY: number;
  tableBottomMargin: number;
  /**
   * The measurement table's groups, in selection order. Each carries the
   * group's label key and its measurement types; a group whose types produced
   * no rows is skipped at render time.
   */
  vitalGroups: ReadonlyArray<{
    id: string;
    labelKey: string;
    types: readonly string[];
  }>;
  unitFor: (type: string) => string;
  ensureSpace: (current: number, needed: number) => number;
}

export function pdfCursorState(
  doc: jsPDF,
  y: number,
): DoctorReportPdfCursorState {
  return { y, pageNumber: doc.getNumberOfPages() };
}
