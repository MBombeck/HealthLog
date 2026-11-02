import { readFileSync } from "node:fs";
import { join } from "node:path";
import { jsPDF } from "jspdf";
import { applyPlugin, type UserOptions } from "jspdf-autotable";

import type { Locale } from "@/lib/i18n/config";

/**
 * The font family every string in the doctor report is drawn in.
 *
 * jsPDF's built-in Helvetica is WinAnsi-encoded, so anything outside Latin-1
 * (Polish, Cyrillic, Greek, Hangul, arrows) drew as a `.notdef` box. The
 * report embeds Unicode TrueType fonts instead, built from Noto Sans, Noto
 * Sans Math and Noto Sans KR by `scripts/build-pdf-fonts.py` (SIL Open Font
 * License 1.1, `fonts/OFL.txt`). jsPDF has no per-glyph fallback, so each
 * file carries every script it is meant for:
 *
 * - `ReportSans-*` (about 190 KB each): Latin incl. Extended-A/B, Greek,
 *   Cyrillic, punctuation, super-/subscripts, currency, arrows and
 *   mathematical operators. Regular, bold and italic.
 * - `ReportSansKR-*` (about 2.7 MB each): the same plus Hangul. Read only
 *   for a report that contains Hangul, so the other locales never load it.
 *   Hangul has no italic; the italic style maps to the upright regular.
 *
 * jsPDF subsets each font to the glyphs a document uses, so the size of the
 * produced PDF does not follow the size of these files.
 *
 * The files are read from disk at render time. The standalone build cannot
 * see a path assembled at runtime, so `next.config.ts` names the directory in
 * `outputFileTracingIncludes`.
 */
export const PDF_FONT_FAMILY = "ReportSans";

type FontStyle = "normal" | "bold" | "italic";

const FONT_DIR = join(process.cwd(), "src/lib/doctor-report-pdf/fonts");

const LATIN_FILES: Record<FontStyle, string> = {
  normal: "ReportSans-Regular.ttf",
  bold: "ReportSans-Bold.ttf",
  italic: "ReportSans-Italic.ttf",
};

const HANGUL_FILES: Record<FontStyle, string> = {
  normal: "ReportSansKR-Regular.ttf",
  bold: "ReportSansKR-Bold.ttf",
  italic: "ReportSansKR-Regular.ttf",
};

/** Jamo, compatibility jamo, jamo extended-A/B and the syllable block. */
const HANGUL_RE = /[\u1100-\u11FF\u3130-\u318F\uA960-\uA97F\uAC00-\uD7FF]/;

// The plugin form of jspdf-autotable is the one that can set per-document
// defaults, so every table in the report inherits the font without each call
// naming it.
applyPlugin(jsPDF);

type AutoTableDocument = jsPDF & {
  autoTableSetDefaults(defaults: UserOptions): jsPDF;
};

/** Base64 per file, read once per process. */
const fontCache = new Map<string, string>();

function fontBase64(file: string): string {
  let encoded = fontCache.get(file);
  if (encoded === undefined) {
    encoded = readFileSync(join(FONT_DIR, file)).toString("base64");
    fontCache.set(file, encoded);
  }
  return encoded;
}

/**
 * Whether the report needs the Hangul font: a Korean report, or any other
 * whose data carries Hangul (a medication name, a note, a lab name).
 */
export function reportNeedsHangul(locale: Locale, data: unknown): boolean {
  return locale === "ko" || HANGUL_RE.test(JSON.stringify(data) ?? "");
}

/**
 * Register the report fonts on one jsPDF instance, make them current, and
 * make them the default of every autoTable drawn on it. Callers name
 * `PDF_FONT_FAMILY` in every `setFont`.
 */
export function registerReportFonts(doc: jsPDF, withHangul: boolean): void {
  const files = withHangul ? HANGUL_FILES : LATIN_FILES;
  for (const style of Object.keys(files) as FontStyle[]) {
    const file = files[style];
    doc.addFileToVFS(file, fontBase64(file));
    doc.addFont(file, PDF_FONT_FAMILY, style);
  }
  doc.setFont(PDF_FONT_FAMILY, "normal");
  (doc as AutoTableDocument).autoTableSetDefaults({
    styles: { font: PDF_FONT_FAMILY },
  });
}
