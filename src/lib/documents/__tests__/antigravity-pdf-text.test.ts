import { describe, it, expect, vi, beforeEach } from "vitest";

const readPdfTextLayer = vi.hoisted(() => vi.fn());
const detectOcrMimeType = vi.hoisted(() => vi.fn());

vi.mock("@/lib/documents/pdf-text-layer", () => ({
  readPdfTextLayer,
  textLayerText: (layer: { pages: { text: string }[] }) =>
    layer.pages.map((p) => p.text).join("\n"),
}));
vi.mock("@/lib/labs/ocr-upload", () => ({ detectOcrMimeType }));

import { antigravityPdfTextIfComplete } from "../antigravity-pdf-text";

const bytes = Buffer.from("%PDF-1.4 test");

function layer(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    pageCount: 2,
    pagesRead: 2,
    pages: [
      { page: 1, text: "Glukoza 95 mg/dl" },
      { page: 2, text: "TSH 2.1 mIU/l" },
    ],
    pagesWithoutText: [],
    ...overrides,
  };
}

describe("antigravityPdfTextIfComplete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    detectOcrMimeType.mockReturnValue("application/pdf");
  });

  it("returns the text when every page has a text layer", async () => {
    readPdfTextLayer.mockResolvedValue({ ok: true, layer: layer() });

    const text = await antigravityPdfTextIfComplete(bytes, "documents.extract");

    expect(text).toBe("Glukoza 95 mg/dl\nTSH 2.1 mIU/l");
    expect(readPdfTextLayer).toHaveBeenCalledWith(
      bytes,
      50,
      "documents.extract",
    );
  });

  it("returns null when one page is a scan", async () => {
    readPdfTextLayer.mockResolvedValue({
      ok: true,
      layer: layer({ pagesWithoutText: [2] }),
    });
    expect(
      await antigravityPdfTextIfComplete(bytes, "documents.summary"),
    ).toBeNull();
  });

  it("returns null when the PDF is longer than the pages read", async () => {
    readPdfTextLayer.mockResolvedValue({
      ok: true,
      layer: layer({ pageCount: 80, pagesRead: 50 }),
    });
    expect(
      await antigravityPdfTextIfComplete(bytes, "documents.summary"),
    ).toBeNull();
  });

  it("returns null when the layer cannot be read", async () => {
    readPdfTextLayer.mockResolvedValue({ ok: false, reason: "unreadable" });
    expect(
      await antigravityPdfTextIfComplete(bytes, "documents.summary"),
    ).toBeNull();
  });

  it("does not open a file that is not a PDF", async () => {
    detectOcrMimeType.mockReturnValue("image/jpeg");
    expect(
      await antigravityPdfTextIfComplete(
        Buffer.from([0xff, 0xd8]),
        "documents.summary",
      ),
    ).toBeNull();
    expect(readPdfTextLayer).not.toHaveBeenCalled();
  });
});
