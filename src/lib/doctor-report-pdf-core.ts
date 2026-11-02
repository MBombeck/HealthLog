/**
 * Server-side PDF renderer for the doctor report.
 *
 * Callers are the clinician share link's `/c/[token]/report.pdf` route and
 * the health-record export. The comment here
 * named `/api/doctor-report/pdf` until 2026-08-23; that route was removed and
 * the sweep behind the retired-route registry found the reference still
 * standing. All locale-sensitive
 * strings and number/date formatting are driven by the injected
 * `{ t, locale }` so the output matches the user's UI language.
 *
 * The text is drawn in embedded Unicode fonts read from disk
 * (`doctor-report-pdf/fonts.ts`), which ties the renderer to Node.
 */
import { jsPDF } from "jspdf";
import type { MeasurementType } from "@/generated/prisma/client";
import {
  isStructuredLeafId,
  REPORT_GROUPS,
} from "./report-selection/catalogue";

import {
  DOCTOR_REPORT_TYPE_UNIT_KEYS,
  reportStatUnit,
} from "./doctor-report/stat-display";
import { resolveGlucoseUnit } from "./glucose";
import {
  makeFormatters,
  type DateFormatPreference,
  type TimeFormatPreference,
} from "./format-locale";
import type { Locale } from "./i18n/config";
import { isValidTimezone } from "./tz/format";
import type { DoctorReportData } from "./doctor-report-data";
import { buildEmergencyFirstPageSection } from "./doctor-report-pdf/emergency-first-page-section";
import { buildHeaderProfileSection } from "./doctor-report-pdf/header-profile-section";
import { buildMeasurementsChartsSection } from "./doctor-report-pdf/measurements-charts-section";
import { buildMedicationMoodWellnessSection } from "./doctor-report-pdf/medication-mood-wellness-section";
import { buildWorkoutsSection } from "./doctor-report-pdf/activity-effect-sections";
import { buildClinicalRecordsNotesSection } from "./doctor-report-pdf/clinical-records-notes-section";
import { buildReportFooter } from "./doctor-report-pdf/footer-section";
import {
  pdfCursorState,
  type DoctorReportPdfRenderContext,
} from "./doctor-report-pdf/render-context";
import {
  registerReportFonts,
  reportNeedsHangul,
} from "./doctor-report-pdf/fonts";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";

type T = (key: string, params?: Record<string, string | number>) => string;

export interface DoctorReportRenderOptions {
  t: T;
  locale: Locale;
  /**
   * Optional fixed timestamp for "createdOn"/footer. Useful for deterministic
   * tests; defaults to `new Date()`.
   */
  now?: Date;
  /**
   * v1.4.25 — per-user display timezone. When omitted the report
   * renders timestamps in Europe/Berlin (legacy contract). Server
   * callers pass `resolveUserTimezone(user.id)`; client callers pass
   * the value from auth context so a US user's PDF carries
   * Eastern-time rows even when generated in the browser.
   */
  userTz?: string;
  /**
   * v1.25.4 — the user's hour-cycle preference. Threaded into the formatters
   * so the footer "generated at" timestamp (and any other clock the report
   * prints) honours H12 / H24 rather than falling to the locale default.
   *
   * Issue #922 — both preferences are REQUIRED. They used to default to
   * AUTO here, which reads as harmless and is not: a report is exactly the
   * artefact a person hands to someone else, and "the caller forgot" and
   * "the user chose the locale default" have to be different states or
   * nobody ever finds the first one. A caller with genuinely no user in
   * hand passes "AUTO" and says so at the call site.
   */
  timeFormat: TimeFormatPreference;
  /** The user's date-order preference (AUTO / DMY / MDY / YMD). */
  dateFormat: DateFormatPreference;
  /**
   * v1.7.0 — decrypted KVNR (German insurance number). Printed on the
   * cover when present; the column is encrypted at rest, so the route
   * decrypts it and hands the plaintext in here. Null/undefined omits
   * the cover line exactly like an unset practice name.
   */
  insuranceNumber?: string | null;
  /**
   * v1.7.0 — embed jsPDF-native trend sparklines per primary vital.
   * Defaults to `true`. Off produces a compact text-only report.
   */
  includeCharts?: boolean;
}

// The unit map moved beside the clinician view's reader of it; re-exported so
// the enum-coverage test keeps one import.
export { DOCTOR_REPORT_TYPE_UNIT_KEYS };

/**
 * The measurement table is driven by the selection, not by a whitelist.
 *
 * It used to be a fixed nine types, which meant a user could select resting
 * heart rate, see it in the FHIR bundle and in the share view, and not find it
 * in the PDF — a per-format divergence on a document whose whole point is that
 * every format describes the same record. The table now prints every selected
 * measurement leaf that has data, sub-headed by the same twelve groups the
 * selection panel shows, so the panel reads as a table of contents for the
 * artefact.
 *
 * The aggregator has already applied the selection, so `data.stats` carries
 * exactly the admitted leaves and nothing here can over-serve.
 */
export const DOCTOR_REPORT_VITAL_GROUPS = REPORT_GROUPS.map((group) => ({
  id: group.id,
  labelKey: group.labelKey,
  types: group.leaves.filter(
    (leaf): leaf is MeasurementType => !isStructuredLeafId(leaf),
  ),
})).filter((group) => group.types.length > 0);

/**
 * Render the doctor report into a `jsPDF` instance.
 *
 * `renderDoctorReportPdfBytes` serialises the returned doc; tests inspect it
 * directly.
 */
export function buildDoctorReportPdfDocument(
  data: DoctorReportData,
  options: DoctorReportRenderOptions,
): jsPDF {
  const {
    t,
    locale,
    now = new Date(),
    userTz,
    timeFormat,
    dateFormat,
    insuranceNumber = null,
    includeCharts = true,
  } = options;
  const formatters = makeFormatters(locale, userTz, timeFormat, dateFormat);
  const num = (value: number, decimals = 1) =>
    formatters.number(value, decimals);
  const fmtDate = (iso: string) => formatters.date(iso);
  const footerTz =
    userTz && isValidTimezone(userTz) ? userTz : DEFAULT_TIMEZONE;

  const glucoseUnit = resolveGlucoseUnit(data.glucoseUnit ?? null);
  const unitFor = (type: string): string =>
    reportStatUnit(type, glucoseUnit, t);

  const doc = new jsPDF({
    orientation: "portrait",
    unit: "mm",
    format: "a4",
    compress: true,
  });
  registerReportFonts(doc, reportNeedsHangul(locale, data));
  doc.setProperties({
    title: t("doctorReport.title"),
    subject: t("doctorReport.subtitle"),
    creator: "HealthLog",
    author: data.patient.fullName ?? data.patient.username ?? "HealthLog",
  });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 20;
  const footerHeight = 16;
  const bottomMargin = 6;
  const contentMaxY = pageHeight - bottomMargin - footerHeight;
  const tableBottomMargin = bottomMargin + footerHeight;
  const ensureSpace = (current: number, needed: number): number => {
    if (current + needed > contentMaxY) {
      doc.addPage();
      return margin;
    }
    return current;
  };

  const context: DoctorReportPdfRenderContext = {
    doc,
    data,
    t,
    num,
    fmtDate,
    dateShort: formatters.dateShort,
    dateTime: formatters.dateTime,
    now,
    insuranceNumber,
    includeCharts,
    footerTz,
    margin,
    pageWidth,
    pageHeight,
    contentMaxY,
    tableBottomMargin,
    vitalGroups: DOCTOR_REPORT_VITAL_GROUPS,
    unitFor,
    ensureSpace,
  };

  let cursor = pdfCursorState(doc, margin);
  // The emergency sheet owns page one. It renders only when emergency data is
  // present (the aggregator gates on the EMERGENCY leaf + presence), and when it
  // does, an explicit page break sends the rest of the report to page two so the
  // opening page carries nothing else.
  if (data.emergency) {
    cursor = buildEmergencyFirstPageSection(context, cursor);
    doc.addPage();
    cursor = pdfCursorState(doc, margin);
  }
  cursor = buildHeaderProfileSection(context, cursor);
  cursor = buildMeasurementsChartsSection(context, cursor);
  cursor = buildWorkoutsSection(context, cursor);
  cursor = buildMedicationMoodWellnessSection(context, cursor);
  cursor = buildClinicalRecordsNotesSection(context, cursor);
  buildReportFooter(context, cursor);
  return doc;
}

/**
 * Render the doctor report and return the PDF as a `Uint8Array`.
 */
export function renderDoctorReportPdfBytes(
  data: DoctorReportData,
  options: DoctorReportRenderOptions,
): Uint8Array {
  const doc = buildDoctorReportPdfDocument(data, options);
  const ab = doc.output("arraybuffer");
  return new Uint8Array(ab);
}
