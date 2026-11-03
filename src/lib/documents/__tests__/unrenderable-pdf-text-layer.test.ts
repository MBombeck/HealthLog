/**
 * #1311 — a PDF on a server whose CPU cannot run the page renderer, for a
 * provider that only takes images. Its text layer is read instead, through the
 * real reader child; a scan, which has none, is answered as what it is.
 * Every case runs the real `rasterizePdf` behind the real CPU gate, closed with
 * the `NATIVE_CANVAS=off` override, or open where this machine renders.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Buffer } from "node:buffer";
import { jsPDF } from "jspdf";

vi.mock("@/lib/documents/store", () => ({
  decryptDocumentContent: vi.fn(),
}));

import { decryptDocumentContent } from "@/lib/documents/store";

import { prepareVisionInput } from "../ai-route-support";
import { __resetNativeCanvasSupportForTests } from "../native-canvas-support";
import { planVisionReads, SYNCHRONOUS_READ_SCHEDULE } from "../ocr-plan";
import { readPdfTextLayer } from "../pdf-text-layer";

/** A 1×1 PNG: a page carrying only this is a scan with no text layer. */
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

type Page = { text: string } | { scan: true; stamp?: string };

/** A PDF of text pages and scanned (image-only) pages. */
function buildPdf(pages: Page[]): Buffer {
  const doc = new jsPDF();
  pages.forEach((page, i) => {
    if (i > 0) doc.addPage();
    if ("text" in page) {
      page.text
        .split("\n")
        .forEach((line, n) => doc.text(line, 10, 15 + n * 8));
    } else {
      doc.addImage(`data:image/png;base64,${PNG}`, "PNG", 10, 10, 180, 250);
      // A scanner's stamp: a few characters of text over the picture.
      if (page.stamp) doc.text(page.stamp, 10, 290);
    }
  });
  return Buffer.from(doc.output("arraybuffer"));
}

const LAB_PAGE = {
  text: "Haemoglobin 14.2 g/dl 13.5 - 17.5\nLeukocytes 6.1 /nl 4.0 - 10.0\nCreatinine 0.9 mg/dl 0.7 - 1.2",
};
const LETTER_PAGE = {
  text: "Discharge letter\nDiagnosis: community-acquired pneumonia, resolved",
};
const SCAN = { scan: true as const, stamp: "Page 2" };

const DOC = {
  id: "doc-1",
  kind: "OTHER",
  contentEncrypted: new Uint8Array([1]),
  contentCodec: "binary2",
  mimeType: "application/pdf",
  status: "STORED",
  aiReadDeferred: false,
};

function stored(bytes: Buffer): void {
  vi.mocked(decryptDocumentContent).mockReturnValue(bytes as never);
}

describe("on a server that cannot render PDF pages", () => {
  beforeAll(() => {
    process.env.NATIVE_CANVAS = "off";
    __resetNativeCanvasSupportForTests();
  });
  afterAll(() => {
    delete process.env.NATIVE_CANVAS;
    __resetNativeCanvasSupportForTests();
  });

  describe("readPdfTextLayer", () => {
    it("reads each page's text layer, and counts a stamped scan as a page without one", async () => {
      const read = await readPdfTextLayer(
        buildPdf([LAB_PAGE, SCAN, LETTER_PAGE]),
        10,
        "test",
      );
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.layer.pageCount).toBe(3);
      expect(read.layer.pagesRead).toBe(3);
      expect(read.layer.pages.map((p) => p.page)).toEqual([1, 3]);
      expect(read.layer.pages[0].text).toContain("Haemoglobin 14.2");
      expect(read.layer.pagesWithoutText).toEqual([2]);
    }, 30_000);

    it("finds no text layer in a scan", async () => {
      await expect(
        readPdfTextLayer(buildPdf([SCAN, { scan: true }]), 10, "test"),
      ).resolves.toEqual({ ok: false, reason: "none" });
    }, 30_000);

    it("reports a file pdf.js cannot open as unreadable", async () => {
      await expect(
        readPdfTextLayer(Buffer.from("%PDF-1.4\nnot a pdf"), 10, "test"),
      ).resolves.toEqual({ ok: false, reason: "unreadable" });
    }, 30_000);

    it("stops at the page cap and says how many pages there are", async () => {
      const read = await readPdfTextLayer(
        buildPdf([LAB_PAGE, LETTER_PAGE, LAB_PAGE]),
        2,
        "test",
      );
      expect(read).toMatchObject({
        ok: true,
        layer: { pageCount: 3, pagesRead: 2, pagesWithoutText: [] },
      });
    }, 30_000);
  });

  describe("prepareVisionInput", () => {
    it("reads a text-layer PDF as text for a provider that only takes images", async () => {
      stored(buildPdf([LAB_PAGE, LETTER_PAGE]));
      const vision = await prepareVisionInput(DOC, false);
      expect(vision).toMatchObject({ ok: true, mode: "text", partial: false });
      if (!vision.ok || vision.mode !== "text") return;
      expect(vision.text).toContain("Creatinine 0.9 mg/dl");
      expect(vision.text).toContain("community-acquired pneumonia");
    }, 30_000);

    it("marks the text read partial when a page is a scan", async () => {
      stored(buildPdf([LAB_PAGE, SCAN]));
      await expect(prepareVisionInput(DOC, false)).resolves.toMatchObject({
        ok: true,
        mode: "text",
        partial: true,
      });
    }, 30_000);

    it("answers a scan with pdfRendererUnavailable, never as a read", async () => {
      stored(buildPdf([SCAN]));
      await expect(prepareVisionInput(DOC, false)).resolves.toEqual({
        ok: false,
        reason: "pdfRendererUnavailable",
      });
    }, 30_000);

    it("still sends the PDF whole to a provider that takes PDFs", async () => {
      const bytes = buildPdf([SCAN]);
      stored(bytes);
      await expect(prepareVisionInput(DOC, true)).resolves.toEqual({
        ok: true,
        mode: "vision",
        images: [],
        documents: [
          {
            mediaType: "application/pdf",
            dataBase64: bytes.toString("base64"),
          },
        ],
      });
    }, 30_000);
  });

  describe("planVisionReads", () => {
    it("plans a text-layer PDF as text reads by page, leaving the scanned page out", async () => {
      const plan = await planVisionReads(
        buildPdf([LAB_PAGE, SCAN, LETTER_PAGE]),
        "application/pdf",
        false,
        { maxModelCalls: () => 100, arm: async () => undefined },
      );
      expect(plan).toMatchObject({
        ok: true,
        mode: "text",
        totalPages: 3,
        pagesWithoutText: [2],
      });
      if (!plan.ok || plan.mode !== "text") return;
      expect(plan.chunks.map((c) => c.pages)).toEqual([[1], [3]]);
      expect(plan.chunks[0].text).toContain("Leukocytes 6.1");
      expect(plan.chunks.every((c) => !c.images && !c.documents)).toBe(true);
      expect(plan.ocrText).toContain("Leukocytes 6.1");
      expect(plan.ocrText).toContain("Discharge letter");
    }, 30_000);

    it("answers a scan with rendererUnavailable", async () => {
      await expect(
        planVisionReads(
          buildPdf([SCAN]),
          "application/pdf",
          false,
          SYNCHRONOUS_READ_SCHEDULE,
        ),
      ).resolves.toEqual({ ok: false, reason: "rendererUnavailable" });
    }, 30_000);

    it("sends the PDF whole to a provider that takes PDFs", async () => {
      const plan = await planVisionReads(
        buildPdf([SCAN]),
        "application/pdf",
        true,
        SYNCHRONOUS_READ_SCHEDULE,
      );
      expect(plan).toMatchObject({ ok: true, mode: "vision" });
      if (!plan.ok) return;
      expect(plan.chunks).toHaveLength(1);
      expect(plan.chunks[0].documents).toHaveLength(1);
    }, 30_000);
  });
});

describe("on a server that renders PDF pages", () => {
  beforeAll(() => {
    process.env.NATIVE_CANVAS = "on";
    __resetNativeCanvasSupportForTests();
  });
  afterAll(() => {
    delete process.env.NATIVE_CANVAS;
    __resetNativeCanvasSupportForTests();
  });

  it("prepareVisionInput renders a text-layer PDF to page images, as before", async () => {
    stored(buildPdf([LAB_PAGE, LETTER_PAGE]));
    const vision = await prepareVisionInput(DOC, false);
    expect(vision).toMatchObject({ ok: true, mode: "vision", documents: [] });
    if (!vision.ok || vision.mode !== "vision") return;
    expect(vision.images).toHaveLength(2);
    expect(vision.images[0].mediaType).toBe("image/jpeg");
  }, 60_000);

  it("planVisionReads reads rendered pages, not text, and reports a render failure as renderFailed", async () => {
    const plan = await planVisionReads(
      buildPdf([LAB_PAGE, LETTER_PAGE]),
      "application/pdf",
      false,
      SYNCHRONOUS_READ_SCHEDULE,
    );
    expect(plan).toMatchObject({ ok: true, mode: "vision", totalPages: 2 });
    if (plan.ok) expect(plan.chunks[0].images?.length).toBeGreaterThan(0);

    await expect(
      planVisionReads(
        Buffer.from("%PDF-1.4\nnot a pdf"),
        "application/pdf",
        false,
        SYNCHRONOUS_READ_SCHEDULE,
      ),
    ).resolves.toEqual({ ok: false, reason: "renderFailed" });
  }, 60_000);
});
