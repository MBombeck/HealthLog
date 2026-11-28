import { readFileSync } from "node:fs";
import { join } from "node:path";

import { jsPDF } from "jspdf";

import { readSource } from "@/__tests__/helpers/source-files";
import { describe, expect, it } from "vitest";

import {
  PDF_FONT_FAMILY,
  registerReportFonts,
  reportScript,
  type ReportScript,
} from "../fonts";
import { locales } from "@/lib/i18n/config";

const FONT_DIR = "src/lib/doctor-report-pdf/fonts";

describe("doctor-report fonts", () => {
  it("ships the OFL licence beside the font files", () => {
    const licence = readSource(
      `${FONT_DIR}/OFL.txt`,
      "SIL Open Font License, Version 1.1",
    );
    expect(licence).toContain("The Noto Project Authors");
    expect(licence).toContain("Adobe");
  });

  it("names the font directory in the standalone trace includes", () => {
    // The files are read by a path built at runtime; without the include the
    // production image ships the renderer and none of its fonts.
    const config = readSource("next.config.ts", "outputFileTracingIncludes");
    expect(config).toContain(`"./${FONT_DIR}/**"`);
  });

  it("registers every style in every variant", () => {
    for (const script of ["latin", "hangul", "han"] as const) {
      const doc = new jsPDF();
      registerReportFonts(doc, script);
      const styles = doc.getFontList()[PDF_FONT_FAMILY];
      expect(styles?.sort()).toEqual(["bold", "italic", "normal"]);
      expect(doc.getFont().fontName).toBe(PDF_FONT_FAMILY);
    }
  });

  it("loads the Hangul font for a Korean report or Hangul in the data", () => {
    expect(reportScript("ko", { name: "Ramipril" })).toBe("hangul");
    expect(reportScript("en", { name: "혈압 측정" })).toBe("hangul");
    expect(reportScript("pl", { name: "Łódź" })).toBe("latin");
    expect(reportScript("en", { name: "Давление крови" })).toBe("latin");
  });

  it("loads the Han font for a Chinese report or Han in the data", () => {
    expect(reportScript("zh-CN", { name: "Ramipril" })).toBe("han");
    expect(reportScript("de", { name: "二甲双胍" })).toBe("han");
    expect(reportScript("ko", { name: "二甲双胍" })).toBe("hangul");
  });

  // Every character a report's own text can draw must have a glyph in the
  // font that report is drawn in; jsPDF has no fallback, a missing glyph is
  // a box. Emoji in a bundle never reach the report's fonts and are skipped.
  it.each(locales)("draws every %s report string", (locale) => {
    const bundle = JSON.parse(
      readFileSync(join(process.cwd(), "messages", `${locale}.json`), "utf8"),
    ) as { doctorReport: unknown };
    const text = JSON.stringify(bundle.doctorReport);
    const script: ReportScript = reportScript(locale, {});
    const doc = new jsPDF();
    registerReportFonts(doc, script);
    const codeMap = (
      doc.getFont() as unknown as {
        metadata: { cmap: { unicode: { codeMap: Record<number, number> } } };
      }
    ).metadata.cmap.unicode.codeMap;
    const missing = [
      ...new Set(
        [...text].filter(
          (ch) =>
            !/\p{Extended_Pictographic}|\s/u.test(ch) &&
            !codeMap[ch.codePointAt(0) as number],
        ),
      ),
    ];
    expect(missing).toEqual([]);
  });
});
