import { jsPDF } from "jspdf";
import { describe, expect, it } from "vitest";

import { pageTextLayer, readPdfText, type PdfTextItem } from "../pdfjs";

/**
 * The text layer as the content index reads it. The layout is the one the
 * local text read produced before it moved onto the app's own pdf.js (#1277):
 * a break where pdf.js marks one or the next item sits on a lower line, a tab
 * between far-apart items on one line, each page followed by a blank line.
 */

/** A page whose viewport maps PDF space to itself, flipped like pdf.js. */
function pageOf(items: PdfTextItem[]) {
  return {
    getViewport: () => ({
      width: 600,
      height: 800,
      convertToViewportPoint: (x: number, y: number) => [x, 800 - y],
    }),
    getTextContent: async () => ({ items }),
  };
}

function item(
  str: string,
  x: number,
  y: number,
  extra: Partial<PdfTextItem> = {},
): PdfTextItem {
  return {
    str,
    transform: [10, 0, 0, 10, x, y],
    width: str.length * 5,
    height: 10,
    hasEOL: false,
    ...extra,
  };
}

describe("pageTextLayer", () => {
  it("breaks once where pdf.js marks the end of a line", async () => {
    const text = await pageTextLayer(
      pageOf([
        item("Haemoglobin", 10, 700, { hasEOL: true }),
        item("14.2 g/dL", 10, 688),
      ]),
    );
    expect(text).toBe("Haemoglobin\n14.2 g/dL");
  });

  it("breaks when the next item sits a line lower without a marked end", async () => {
    const text = await pageTextLayer(
      pageOf([item("Creatinine", 10, 700), item("0.9 mg/dL", 10, 680)]),
    );
    expect(text).toBe("Creatinine\n0.9 mg/dL");
  });

  it("does not break for a small baseline shift on one line", async () => {
    const text = await pageTextLayer(
      pageOf([item("10", 10, 700), item("3", 21, 703)]),
    );
    expect(text).toBe("103");
  });

  it("separates far-apart items on one line with a tab", async () => {
    const text = await pageTextLayer(
      pageOf([item("Glucose", 10, 700), item("92", 200, 700)]),
    );
    expect(text).toBe("Glucose\t92");
  });

  it("skips marked-content items, which carry no text", async () => {
    const text = await pageTextLayer(
      pageOf([{ hasEOL: false } as PdfTextItem, item("Text", 10, 700)]),
    );
    expect(text).toBe("Text");
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

  it("joins pages with a blank line and adds no page markers", async () => {
    const text = await readPdfText(pages(2));
    expect(text).toBe(
      "Page 1 lab report\nsecond line\n\nPage 2 lab report\nsecond line\n\n",
    );
  });

  it("reads no further than the page cap", async () => {
    const text = await readPdfText(pages(3), 2);
    expect(text).toContain("Page 2");
    expect(text).not.toContain("Page 3");
  });

  it("throws what pdf.js throws on a file that is not a PDF", async () => {
    await expect(readPdfText(Buffer.from("not a pdf"))).rejects.toThrow();
  });
});
