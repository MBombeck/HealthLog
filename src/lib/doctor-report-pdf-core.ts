/**
 * Isomorphic PDF renderer for the doctor report.
 *
 * Runs identically in the browser (settings page download) and in Node
 * (the clinician share link's `/c/[token]/report.pdf` route). The comment here
 * named `/api/doctor-report/pdf` until 2026-08-23; that route was removed and
 * the sweep behind the retired-route registry found the reference still
 * standing. All locale-sensitive
 * strings and number/date formatting are driven by the injected
 * `{ t, locale }` so DE and EN output match the user's UI language.
 *
 * jsPDF is fully isomorphic: `doc.output("arraybuffer")` returns a valid
 * `%PDF-` byte stream in both environments.
 */
import { jsPDF } from "jspdf";
import type { MeasurementType } from "@/generated/prisma/client";
import {
  isStructuredLeafId,
  REPORT_GROUPS,
} from "./report-selection/catalogue";

import { getUnitForType } from "./validations/measurement";
import {
  makeFormatters,
  DISPLAY_TIMEZONE,
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
import { buildClinicalRecordsNotesSection } from "./doctor-report-pdf/clinical-records-notes-section";
import { buildReportFooter } from "./doctor-report-pdf/footer-section";
import {
  pdfCursorState,
  type DoctorReportPdfRenderContext,
} from "./doctor-report-pdf/render-context";

type T = (key: string, params?: Record<string, string | number>) => string;

/**
 * jsPDF's built-in Helvetica is WinAnsi-encoded. Latin-1 glyphs (umlauts,
 * ß, em-/en-dash, typographic quotes, °, µ) carry correct metrics, but any
 * code point outside WinAnsi resolves to the `.notdef` box at a single
 * fallback advance width. The widths then disagree with the drawn glyph and
 * the surrounding words stretch / shift — the visible "stretched line" bug.
 *
 * This sanitiser maps every glyph the report can emit that falls outside
 * WinAnsi onto a WinAnsi-safe equivalent, applied centrally to every string
 * just before it reaches `doc.text` / `doc.splitTextToSize` (see
 * `patchPdfTextSanitiser`). The offenders that actually occur in the report
 * are the trend arrows (↑ ↓ →) injected by `trendArrow()` + the `glp1WeightSummary`
 * separator, and the superscript-two in "kg/m²". The mapping is exhaustive
 * for those and degrades gracefully for any future stray symbol.
 *
 * Premium follow-up (documented, not a hotfix blocker): embed a Unicode TTF
 * (e.g. DejaVuSans) via `doc.addFileToVFS` / `addFont` so the arrows and
 * superscripts render as their true glyphs instead of ASCII equivalents.
 */
const WINANSI_REPLACEMENTS: Record<string, string> = {
  // Trend arrows → ASCII so the metrics match the drawn glyph.
  "↑": "^", // ↑ up
  "↓": "v", // ↓ down
  "→": "->", // → right (also the glp1 weight separator)
  "←": "<-", // ←
  "↔": "<->", // ↔
  // Super-/subscripts used in "kg/m²".
  "²": "2", // ²
  "³": "3", // ³
  "¹": "1", // ¹
  // Defensive: a few maths/symbol glyphs that are outside WinAnsi but read
  // fine as ASCII, in case a future string introduces them.
  "≈": "~", // ≈
  "≤": "<=", // ≤
  "≥": ">=", // ≥
  "×": "x", // ×
  "€": "EUR", // €
};

const WINANSI_REPLACE_RE = new RegExp(
  `[${Object.keys(WINANSI_REPLACEMENTS).join("")}]`,
  "g",
);

/** Map non-WinAnsi glyphs onto safe equivalents. Pure; exported for tests. */
export function sanitiseForPdf(text: string): string {
  return text.replace(
    WINANSI_REPLACE_RE,
    (ch) => WINANSI_REPLACEMENTS[ch] ?? ch,
  );
}

/**
 * Patch `doc.text` + `doc.splitTextToSize` on a single jsPDF instance so
 * every drawn string (direct text, wrapped paragraphs, AND `jspdf-autotable`
 * cells — which route their content through `doc.text` too) passes through
 * `sanitiseForPdf` first. One choke point instead of a sanitiser call at
 * every site keeps the renderer readable and guarantees coverage.
 */
function patchPdfTextSanitiser(doc: jsPDF): void {
  const clean = (value: unknown): unknown =>
    typeof value === "string"
      ? sanitiseForPdf(value)
      : Array.isArray(value)
        ? value.map((v) => (typeof v === "string" ? sanitiseForPdf(v) : v))
        : value;

  const originalText = doc.text.bind(doc);
  doc.text = function patchedText(
    this: jsPDF,
    ...args: Parameters<jsPDF["text"]>
  ): jsPDF {
    const next = [...args] as unknown[];
    next[0] = clean(next[0]);
    return originalText(...(next as Parameters<jsPDF["text"]>));
  } as jsPDF["text"];

  const originalSplit = doc.splitTextToSize.bind(doc);
  doc.splitTextToSize = function patchedSplit(
    this: jsPDF,
    ...args: Parameters<jsPDF["splitTextToSize"]>
  ): ReturnType<jsPDF["splitTextToSize"]> {
    const next = [...args] as unknown[];
    next[0] = clean(next[0]);
    return originalSplit(...(next as Parameters<jsPDF["splitTextToSize"]>));
  } as jsPDF["splitTextToSize"];
}

export interface DoctorReportRenderOptions {
  t: T;
  locale: Locale;
  /**
   * Optional fixed timestamp for "createdOn"/footer. Useful for deterministic
   * tests; defaults to `new Date()`.
   */
  now?: Date;
  /**
   * v1.4.25 W7 — per-user display timezone. When omitted the report
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

export const DOCTOR_REPORT_TYPE_UNIT_KEYS: Record<string, string | null> = {
  WEIGHT: "kg",
  BLOOD_PRESSURE_SYS: "mmHg",
  BLOOD_PRESSURE_DIA: "mmHg",
  PULSE: "bpm",
  BODY_FAT: "%",
  SLEEP_DURATION: "h",
  ACTIVITY_STEPS: null, // translated unit
  TOTAL_BODY_WATER: "kg",
  BONE_MASS: "kg",
  OXYGEN_SATURATION: "%",
};

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
 * Used internally by both the client wrapper (which calls `.save()` on the
 * returned doc) and the server renderer (which calls `.output("arraybuffer")`
 * via `renderDoctorReportPdfBytes`).
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
    userTz && isValidTimezone(userTz) ? userTz : DISPLAY_TIMEZONE;

  const unitFor = (type: string): string => {
    const staticUnit = DOCTOR_REPORT_TYPE_UNIT_KEYS[type];
    if (staticUnit === null && type === "ACTIVITY_STEPS") {
      return t("doctorReport.unitSteps");
    }
    if (staticUnit !== undefined && staticUnit !== null) return staticUnit;
    // Every other type falls back to the canonical unit the measurement
    // validation layer already records. A type with no recorded unit prints
    // none — an absent unit is absent, not a guessed symbol.
    const canonical = getUnitForType(type);
    return canonical === "unknown" ? "" : canonical;
  };

  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  patchPdfTextSanitiser(doc);
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
  cursor = buildMedicationMoodWellnessSection(context, cursor);
  cursor = buildClinicalRecordsNotesSection(context, cursor);
  buildReportFooter(context, cursor);
  return doc;
}

/**
 * Render the doctor report and return the PDF as a `Uint8Array`.
 * Isomorphic — works in browser and Node.
 */
export function renderDoctorReportPdfBytes(
  data: DoctorReportData,
  options: DoctorReportRenderOptions,
): Uint8Array {
  const doc = buildDoctorReportPdfDocument(data, options);
  const ab = doc.output("arraybuffer");
  return new Uint8Array(ab);
}
