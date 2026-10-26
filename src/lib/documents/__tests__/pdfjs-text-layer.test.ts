import { jsPDF } from "jspdf";
import type {
  TextItem,
  TextMarkedContent,
} from "pdfjs-dist/types/src/display/api";
import { describe, expect, it } from "vitest";

import { joinTextRuns, readPdfText } from "../pdfjs";

/**
 * The text layer as the content index reads it (#1277): runs in order, a line
 * break where a run ends its line or the next one sits on another, a space
 * where two runs on one line leave a gap, and nothing where they touch, so a
 * word drawn in two fonts stays one word and a search for it still finds it.
 */

/** A 10 pt run starting at (x, y), 5 pt per character. */
function run(
  str: string,
  x: number,
  y: number,
  extra: Partial<TextItem> = {},
): TextItem {
  return {
    str,
    dir: "ltr",
    transform: [10, 0, 0, 10, x, y],
    width: str.length * 5,
    height: 10,
    fontName: "g_d0_f1",
    hasEOL: false,
    ...extra,
  };
}

describe("joinTextRuns", () => {
  it("keeps a word drawn in two fonts whole", () => {
    expect(
      joinTextRuns([
        run("Haem", 10, 700),
        run("oglobin", 30, 700, { fontName: "g_d0_f2" }),
      ]),
    ).toBe("Haemoglobin");
  });

  it("puts a space between runs on one line that leave a gap", () => {
    expect(joinTextRuns([run("Glucose", 10, 700), run("92", 200, 700)])).toBe(
      "Glucose 92",
    );
  });

  it("breaks once where a run ends its line", () => {
    expect(
      joinTextRuns([
        run("Haemoglobin", 10, 700, { hasEOL: true }),
        run("14.2 g/dL", 10, 688),
      ]),
    ).toBe("Haemoglobin\n14.2 g/dL");
  });

  it("breaks where the next run sits on another line without a marked end", () => {
    expect(
      joinTextRuns([run("Creatinine", 10, 700), run("0.9", 10, 680)]),
    ).toBe("Creatinine\n0.9");
  });

  it("keeps a raised run on its line", () => {
    expect(joinTextRuns([run("10", 10, 700), run("9", 20, 703)])).toBe("109");
  });

  it("adds no blank line for an empty run that only ends a line", () => {
    expect(
      joinTextRuns([
        run("Line", 10, 700, { hasEOL: true }),
        run("", 30, 700, { hasEOL: true }),
        run("Next", 10, 688),
      ]),
    ).toBe("Line\nNext");
  });

  it("skips marked-content markers, which carry no text", () => {
    const marker: TextMarkedContent = {
      type: "beginMarkedContent",
      id: "mc0",
    };
    expect(joinTextRuns([marker, run("Text", 10, 700)])).toBe("Text");
  });
});

describe("readPdfText", () => {
  function pages(count: number): Buffer {
    const doc = new jsPDF();
    for (let p = 1; p <= count; p++) {
      if (p > 1) doc.addPage();
      doc.text(`Page ${p} lab report`, 10, 10);
      doc.text("second line", 10, 20);
    }
    return Buffer.from(doc.output("arraybuffer"));
  }

  it("reads the pages one after another and adds no page markers", async () => {
    const text = await readPdfText(pages(2));
    expect(text).toBe(
      "Page 1 lab report\nsecond line\nPage 2 lab report\nsecond line",
    );
  });

  it("reads no further than the page cap", async () => {
    const text = await readPdfText(pages(3), 2);
    expect(text).toContain("Page 2");
    expect(text).not.toContain("Page 3");
  });

  it("keeps a word whole that a real PDF draws in two fonts", async () => {
    const doc = new jsPDF();
    doc.setFont("helvetica", "bold");
    doc.text("Haem", 10, 10);
    const joint = 10 + doc.getTextWidth("Haem");
    doc.setFont("times", "normal");
    doc.text("oglobin 14.2 g/dL", joint, 10);
    const text = await readPdfText(Buffer.from(doc.output("arraybuffer")));
    expect(text).toBe("Haemoglobin 14.2 g/dL");
  });

  it("throws what pdf.js throws on a file that is not a PDF", async () => {
    await expect(readPdfText(Buffer.from("not a pdf"))).rejects.toThrow();
  });
});
