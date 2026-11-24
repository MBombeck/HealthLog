import { Buffer } from "node:buffer";

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));

import { rasterScale } from "../pdf-engine.mjs";
import {
  pageText,
  RASTER_DPI,
  RASTER_HARD_MAX_PAGES,
  RASTER_MAX_LONG_EDGE,
  RASTER_MAX_PAGES,
  RASTER_PAGE_TEXT_MAX,
  rasterizePdf,
  TEXT_LAYER_CUT_MARK,
} from "../rasterize-pdf";

/**
 * Rasterization renders a PDF's pages to bounded JPEG images. Pins: a text-layer
 * PDF and a synthetic image-only (graphics-only, no text layer) PDF both render
 * to JPEG page images; the page cap is honoured; malformed input degrades to
 * `{ ok: false }` and never throws.
 *
 * The fixtures are built inline (a tiny hand-assembled PDF with a correct xref)
 * so the test carries no binary blobs.
 */
function buildPdf(pageCount: number, withText: boolean): Buffer {
  return buildPdfFromContents(
    Array.from({ length: pageCount }, (_, p) =>
      withText
        ? `BT /F1 24 Tf 40 120 Td (Page ${p + 1} lab report glucose creatinine) Tj ET`
        : `0 0 1 rg 40 40 120 120 re f`,
    ),
  );
}

/** A PDF with one page per content stream, on the given media box. */
function buildPdfFromContents(
  contents: string[],
  mediaBox = "0 0 200 200",
): Buffer {
  const pageCount = contents.length;
  const pageNums: number[] = [];
  const perPage: { pageNum: number; contentNum: number; content: string }[] =
    [];
  let n = 4;
  for (const content of contents) {
    const pageNum = n++;
    const contentNum = n++;
    pageNums.push(pageNum);
    perPage.push({ pageNum, contentNum, content });
  }

  const bodies: string[] = [];
  bodies[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  bodies[2] = `<< /Type /Pages /Kids [${pageNums
    .map((x) => `${x} 0 R`)
    .join(" ")}] /Count ${pageCount} >>`;
  bodies[3] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;
  for (const { pageNum, contentNum, content } of perPage) {
    bodies[pageNum] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [${mediaBox}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentNum} 0 R >>`;
    bodies[contentNum] =
      `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`;
  }

  const total = n - 1;
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 1; i <= total; i++) {
    offsets[i] = Buffer.byteLength(out, "latin1");
    out += `${i} 0 obj\n${bodies[i]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= total; i++) {
    out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${total + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(out, "latin1");
}

/** JPEG magic bytes. */
function isJpeg(base64: string): boolean {
  const head = Buffer.from(base64, "base64").subarray(0, 2).toString("hex");
  return head === "ffd8";
}

/** Width and height from a baseline or progressive JPEG's frame header. */
function jpegSize(base64: string): { width: number; height: number } {
  const bytes = Buffer.from(base64, "base64");
  let at = 2;
  while (at < bytes.length) {
    const marker = bytes[at + 1]!;
    const length = bytes.readUInt16BE(at + 2);
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      return {
        height: bytes.readUInt16BE(at + 5),
        width: bytes.readUInt16BE(at + 7),
      };
    }
    at += 2 + length;
  }
  throw new Error("no JPEG frame header");
}

/** A page with some ink, on the given media box. */
function sizedPdf(mediaBox: string): Buffer {
  return buildPdfFromContents(
    [
      `0 0 1 rg 40 40 120 120 re f 0 g BT /F1 9 Tf 40 30 Td (12,34 mmol/l) Tj ET`,
    ],
    mediaBox,
  );
}

describe("page resolution", () => {
  // The provider bound the edge cap answers to: OpenAI fits every image into
  // 2048 x 2048 before it reads it.
  const SMALLEST_PROVIDER_FIT = 2048;

  it("keeps the edge cap under every vision wire's hard fit", () => {
    expect(RASTER_MAX_LONG_EDGE).toBeLessThanOrEqual(SMALLEST_PROVIDER_FIT);
    expect(RASTER_DPI).toBeGreaterThanOrEqual(150);
  });

  it("renders an A4 page to the edge cap, well above 72 dpi", async () => {
    const result = await rasterizePdf(sizedPdf("0 0 595.28 841.89"), 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { width, height } = jpegSize(result.images[0]!.dataBase64);
    expect(height).toBe(RASTER_MAX_LONG_EDGE);
    expect(width).toBe(Math.round((595.28 * RASTER_MAX_LONG_EDGE) / 841.89));
    // 842 px was the old height: scale 1, 72 dpi.
    expect((height / 841.89) * 72).toBeGreaterThan(170);
  });

  it("renders a US Letter page to the edge cap", async () => {
    const result = await rasterizePdf(sizedPdf("0 0 612 792"), 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { width, height } = jpegSize(result.images[0]!.dataBase64);
    expect(height).toBe(RASTER_MAX_LONG_EDGE);
    expect(width).toBe(Math.round((612 * RASTER_MAX_LONG_EDGE) / 792));
  });

  it("renders a landscape page with the cap on its width", async () => {
    const result = await rasterizePdf(sizedPdf("0 0 841.89 595.28"), 1);
    expect(result.ok && jpegSize(result.images[0]!.dataBase64).width).toBe(
      RASTER_MAX_LONG_EDGE,
    );
  });

  it("gives a small page the full dpi when it stays under the cap", async () => {
    // A label of 3 x 4 inches: 600 x 800 px at 200 dpi.
    const result = await rasterizePdf(sizedPdf("0 0 216 288"), 1);
    expect(result.ok && jpegSize(result.images[0]!.dataBase64)).toEqual({
      width: (216 / 72) * RASTER_DPI,
      height: (288 / 72) * RASTER_DPI,
    });
  });

  it("never passes the cap, whatever the page size", async () => {
    // An A0 poster and an absurd strip.
    for (const box of ["0 0 2383.94 3370.39", "0 0 14400 200"]) {
      const result = await rasterizePdf(sizedPdf(box), 1);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const { width, height } = jpegSize(result.images[0]!.dataBase64);
      expect(Math.max(width, height)).toBeLessThanOrEqual(RASTER_MAX_LONG_EDGE);
    }
  });

  it("fits the scale to the cap exactly and otherwise uses the dpi", () => {
    const opts = { dpi: RASTER_DPI, maxLongEdge: RASTER_MAX_LONG_EDGE };
    expect(rasterScale(595.28, 841.89, opts) * 841.89).toBeCloseTo(
      RASTER_MAX_LONG_EDGE,
      6,
    );
    expect(rasterScale(216, 288, opts)).toBe(RASTER_DPI / 72);
    expect(rasterScale(0, 0, opts)).toBe(1);
  });
});

describe("rasterizePdf", () => {
  it("renders a text-layer PDF's pages to JPEG images", async () => {
    const result = await rasterizePdf(buildPdf(3, true));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.images).toHaveLength(3);
    for (const img of result.images) {
      expect(img.mediaType).toBe("image/jpeg");
      expect(isJpeg(img.dataBase64)).toBe(true);
    }
  });

  it("renders a synthetic image-only (no text layer) PDF", async () => {
    const result = await rasterizePdf(buildPdf(1, false));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.images).toHaveLength(1);
    expect(isJpeg(result.images[0]!.dataBase64)).toBe(true);
  });

  it("reads each page's text layer beside its image when asked", async () => {
    const result = await rasterizePdf(buildPdf(2, true), 20, {
      withText: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The fixture's line runs off its 200 pt page; pdfjs keeps what is on it.
    expect(result.texts).toHaveLength(2);
    expect(result.texts?.[0]).toMatch(/^Page 1 lab/);
    expect(result.texts?.[1]).toMatch(/^Page 2 lab/);
  });

  it("gives a page without a text layer an empty text, and none unless asked", async () => {
    const scanned = await rasterizePdf(buildPdf(1, false), 20, {
      withText: true,
    });
    expect(scanned.ok && scanned.texts).toEqual([""]);
    const plain = await rasterizePdf(buildPdf(1, true));
    expect(plain.ok && plain.texts).toBeUndefined();
  });

  it("stops collecting a page's text at the cap while reading, cut at a line and marked", async () => {
    // 900 short lines on one tall page: past RASTER_PAGE_TEXT_MAX.
    const lines = Array.from(
      { length: 900 },
      (_, i) => `(Marker ${String(i).padStart(4, "0")} value 12,34) Tj T*`,
    );
    const pdf = buildPdfFromContents(
      // The filled box gives the page ink, so it is not taken for a blank.
      [
        `0 0 1 rg 0 0 200 3000 re f 0 g BT /F1 3 Tf 3 TL 5 2995 Td ${lines.join(" ")} ET`,
      ],
      "0 0 200 3000",
    );
    const result = await rasterizePdf(pdf, 1, { withText: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const text = result.texts?.[0] ?? "";
    expect(text.length).toBeLessThanOrEqual(RASTER_PAGE_TEXT_MAX);
    const kept = text.split("\n");
    expect(kept.at(-1)).toBe(TEXT_LAYER_CUT_MARK);
    expect(kept[0]).toBe("Marker 0000 value 12,34");
    expect(kept.at(-2)).toMatch(/^Marker \d{4} value 12,34$/);
  });

  it("hard-cuts a page that is one endless line instead of keeping only the mark", async () => {
    const endless = "1".repeat(16_000);
    const pdf = buildPdfFromContents(
      [
        `0 0 1 rg 0 0 20000 200 re f 0 g BT /F1 1 Tf 0 100 Td (${endless}) Tj ET`,
      ],
      "0 0 20000 200",
    );
    const result = await rasterizePdf(pdf, 1, { withText: true });
    const text = (result.ok && result.texts?.[0]) || "";
    expect(text.length).toBeLessThanOrEqual(RASTER_PAGE_TEXT_MAX);
    expect(text.endsWith(TEXT_LAYER_CUT_MARK)).toBe(true);
    expect(text.length).toBeGreaterThan(RASTER_PAGE_TEXT_MAX / 2);
  });

  it("stops reading a line that never ends once it passes the cap", async () => {
    // One text item after another with no line end: past the cap the rest
    // is not read into memory at all.
    let read = 0;
    const items = Array.from({ length: 5000 }, () => ({
      get str() {
        read += 1;
        return "123456789";
      },
      hasEOL: false,
    }));
    const text = await pageText({
      getTextContent: async () => ({ items }),
    });
    expect(text.endsWith(TEXT_LAYER_CUT_MARK)).toBe(true);
    expect(read).toBeLessThan(RASTER_PAGE_TEXT_MAX / 5);
  });

  it("lets a caller ask for more pages, never past RASTER_HARD_MAX_PAGES", async () => {
    const result = await rasterizePdf(
      buildPdf(RASTER_HARD_MAX_PAGES + 2, false),
      RASTER_HARD_MAX_PAGES + 10,
    );
    expect(result.ok && result.images).toHaveLength(RASTER_HARD_MAX_PAGES);
  });

  it("caps the number of rendered pages at RASTER_MAX_PAGES", async () => {
    const result = await rasterizePdf(buildPdf(RASTER_MAX_PAGES + 4, true));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.images).toHaveLength(RASTER_MAX_PAGES);
    // The page count travels with the result, so a caller can say the
    // reading stopped short.
    expect(result.pageCount).toBe(RASTER_MAX_PAGES + 4);
  });

  it("honours a caller maxPages bound (thumbnail path renders page 1 only)", async () => {
    const result = await rasterizePdf(buildPdf(5, true), 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.images).toHaveLength(1);
  });

  it("returns { ok: false } and never throws on malformed input", async () => {
    await expect(
      rasterizePdf(Buffer.from("this is not a pdf")),
    ).resolves.toEqual({ ok: false, reason: "render-failed" });
  });

  it("returns { ok: false } on an empty buffer", async () => {
    await expect(rasterizePdf(Buffer.alloc(0))).resolves.toEqual({
      ok: false,
      reason: "render-failed",
    });
  });
});
