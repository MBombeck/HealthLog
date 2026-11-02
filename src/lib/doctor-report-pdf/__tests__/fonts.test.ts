import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { jsPDF } from "jspdf";
import { describe, expect, it } from "vitest";

import {
  PDF_FONT_FAMILY,
  registerReportFonts,
  reportNeedsHangul,
} from "../fonts";

const ROOT = process.cwd();
const FONT_DIR = "src/lib/doctor-report-pdf/fonts";

describe("doctor-report fonts", () => {
  it("ships the OFL licence beside the font files", () => {
    expect(existsSync(join(ROOT, FONT_DIR, "OFL.txt"))).toBe(true);
    expect(readFileSync(join(ROOT, FONT_DIR, "OFL.txt"), "utf8")).toContain(
      "SIL Open Font License, Version 1.1",
    );
  });

  it("names the font directory in the standalone trace includes", () => {
    // The files are read by a path built at runtime; without the include the
    // production image ships the renderer and none of its fonts.
    const config = readFileSync(join(ROOT, "next.config.ts"), "utf8");
    expect(config).toContain(`"./${FONT_DIR}/**"`);
  });

  it("registers every style in both variants", () => {
    for (const withHangul of [false, true]) {
      const doc = new jsPDF();
      registerReportFonts(doc, withHangul);
      const styles = doc.getFontList()[PDF_FONT_FAMILY];
      expect(styles?.sort()).toEqual(["bold", "italic", "normal"]);
      expect(doc.getFont().fontName).toBe(PDF_FONT_FAMILY);
    }
  });

  it("loads the Hangul font for a Korean report or Hangul in the data", () => {
    expect(reportNeedsHangul("ko", { name: "Ramipril" })).toBe(true);
    expect(reportNeedsHangul("en", { name: "혈압 측정" })).toBe(true);
    expect(reportNeedsHangul("pl", { name: "Łódź" })).toBe(false);
    expect(reportNeedsHangul("en", { name: "Давление крови" })).toBe(false);
  });
});
