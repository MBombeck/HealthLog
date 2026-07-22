/**
 * Isomorphic PDF renderer for the doctor report.
 *
 * Runs identically in the browser (settings page download) and in Node
 * (server-rendered `/api/doctor-report/pdf` endpoint). All locale-sensitive
 * strings and number/date formatting are driven by the injected
 * `{ t, locale }` so DE and EN output match the user's UI language.
 *
 * jsPDF is fully isomorphic: `doc.output("arraybuffer")` returns a valid
 * `%PDF-` byte stream in both environments.
 */
import { jsPDF } from "jspdf";
import { DOCTOR_REPORT_TYPE_LABEL_KEYS } from "./doctor-report/type-label-keys";
import {
  makeFormatters,
  DISPLAY_TIMEZONE,
  type TimeFormatPreference,
} from "./format-locale";
import type { Locale } from "./i18n/config";
import { isValidTimezone } from "./tz/format";
import type { DoctorReportData } from "./doctor-report-data";
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
   * prints) honours H12 / H24 rather than falling to the locale default. When
   * omitted it stays AUTO (locale default), matching the legacy contract.
   */
  timeFormat?: TimeFormatPreference;
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
  /**
   * v1.7.0 — optional AI summary text. OUT of the clinical PDF by
   * default; rendered ONLY when the user explicitly opts in, under a
   * clearly-labelled "AI summary — not clinically validated" heading.
   * Null/undefined/empty omits the section entirely.
   */
  aiSummary?: string | null;
}

// Per-vital label keys live in a jsPDF-free module so leaf consumers (the
// public clinician share view) can import the map without dragging the PDF
// renderer into their graph. Re-exported here so the PDF core stays the
// single import surface its existing callers already use.
export { DOCTOR_REPORT_TYPE_LABEL_KEYS };

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
 * Vital types rendered in the main vitals table. Body composition
 * (TOTAL_BODY_WATER, BONE_MASS) ships alongside body fat — Withings
 * smart scales report all three together. SpO2 (Withings ScanWatch type
 * 54, HealthKit, n8n / Health Connect) is rendered last in the same
 * table for clinical readability. Glucose ships separately via
 * per-context `glucoseStats`. SLEEP_DURATION rides this table too: the
 * `sleep` section toggle is default-ON and the data layer reconstructs a
 * per-night time-asleep total (in minutes) for exactly this row — the
 * render loop converts it to hours so value and unit (`h`) agree, matching
 * the FHIR sleep Observation. Activity (steps) stays excluded from a
 * clinical-focused report.
 *
 * v1.10.0 — computed scores (WX-C). The server-derived `*_SCORE` types
 * (RECOVERY_SCORE / STRESS_SCORE / STRAIN_SCORE) are NOT clinical vitals:
 * they are 0–100 composites recomputed nightly from the underlying signals
 * and carry a "descriptive, not a clinical assessment" disclaimer. They stay
 * out of this table by design (paired with `PDF_VITAL_EXCLUSIONS` in
 * `measurement-type-enum-coverage.test.ts`).
 *
 * v1.17.1 — Oura coverage completion. `SLEEP_SCORE` (a nightly derived
 * composite) and `BODY_TEMPERATURE_DEVIATION` (a signed baseline offset, not an
 * absolute reading) are excluded for the same reason as the other derived /
 * lifestyle signals — they are descriptive, not measured clinical vitals.
 *
 * v1.19.0 — Oura resilience. `RESILIENCE` is an ordinal-encoded categorical
 * band (limited=1 … exceptional=5), a derived recovery composite — descriptive,
 * not a measured clinical vital — so it is excluded too.
 *
 * v1.27.9 — WHO-5 / SCI screening totals. `WHO5_SCORE` + `SCI_SCORE` follow
 * the PHQ-9 / GAD-7 precedent: opt-in, derived from an in-app questionnaire,
 * excluded from the vitals table (they ride the module-gated mental-health
 * export section instead, see `doctor-report-data.ts`).
 */
export const DOCTOR_REPORT_VITAL_TYPES = [
  "WEIGHT",
  "BLOOD_PRESSURE_SYS",
  "BLOOD_PRESSURE_DIA",
  "PULSE",
  "BODY_FAT",
  "TOTAL_BODY_WATER",
  "BONE_MASS",
  "OXYGEN_SATURATION",
  "SLEEP_DURATION",
] as const;

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
    timeFormat = "AUTO",
    insuranceNumber = null,
    includeCharts = true,
    aiSummary = null,
  } = options;
  const formatters = makeFormatters(locale, userTz, timeFormat);
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
    return staticUnit ?? "";
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
    aiSummary,
    footerTz,
    margin,
    pageWidth,
    pageHeight,
    contentMaxY,
    tableBottomMargin,
    vitalTypes: DOCTOR_REPORT_VITAL_TYPES,
    unitFor,
    ensureSpace,
  };

  let cursor = pdfCursorState(doc, margin);
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
