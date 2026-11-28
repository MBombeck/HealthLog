import { jsPDF } from "jspdf";

import { readSource } from "@/__tests__/helpers/source-files";
import { describe, expect, it } from "vitest";

import {
  PDF_FONT_FAMILY,
  registerReportFonts,
  reportFontScript,
  reportNeedsHan,
  reportNeedsHangul,
} from "../fonts";

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

  it("registers every style in each of the three variants", () => {
    for (const script of ["latin", "hangul", "han"] as const) {
      const doc = new jsPDF();
      registerReportFonts(doc, script);
      const styles = doc.getFontList()[PDF_FONT_FAMILY];
      expect(styles?.sort(), script).toEqual(["bold", "italic", "normal"]);
      expect(doc.getFont().fontName).toBe(PDF_FONT_FAMILY);
    }
  });

  it("loads the Hangul font for a Korean report or Hangul in the data", () => {
    expect(reportNeedsHangul("ko", { name: "Ramipril" })).toBe(true);
    expect(reportNeedsHangul("en", { name: "혈압 측정" })).toBe(true);
    expect(reportNeedsHangul("pl", { name: "Łódź" })).toBe(false);
    expect(reportNeedsHangul("en", { name: "Давление крови" })).toBe(false);
  });

  it("loads the Han font for Han in the data, and for a Chinese report", () => {
    expect(reportNeedsHan("en", { name: "二甲双胍" })).toBe(true);
    expect(reportNeedsHan("en", { note: "血压偏低" })).toBe(true);
    // Extension A, outside the base block the GB2312 subset starts from.
    expect(reportNeedsHan("en", { name: "㐀" })).toBe(true);
    expect(reportNeedsHan("pl", { name: "Łódź" })).toBe(false);
    expect(reportNeedsHan("en", { name: "コレステロール" })).toBe(false);
    // A Chinese report whose stored values are all Latin still needs it for
    // its own labels. `zh-CN` is named ahead of the locale, hence the cast.
    expect(reportNeedsHan("zh-CN" as never, { name: "Ramipril" })).toBe(true);
  });

  it("picks one font when a report holds both scripts", () => {
    // Only one of the two can be registered, and Han is the one that would
    // otherwise draw as boxes.
    expect(reportFontScript("en", { a: "血压", b: "혈압" })).toBe("han");
    expect(reportFontScript("ko", { a: "Ramipril" })).toBe("hangul");
    expect(reportFontScript("pl", { a: "Łódź" })).toBe("latin");
  });
});
