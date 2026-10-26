import { describe, expect, it, vi } from "vitest";

/**
 * A PDF that crosses the reader's memory or time bound is reported as such
 * (`resource-limit`), not as a read error, which the index job records as a
 * stored file that would not open. The bound itself is the isolated reader's
 * (`../pdf-isolation.ts`); here it is the error it throws.
 */

const { annotate, logCaught, readPdfText } = vi.hoisted(() => ({
  annotate: vi.fn(),
  logCaught: vi.fn(),
  readPdfText: vi.fn(),
}));
vi.mock("@/lib/logging/context", () => ({ annotate }));
vi.mock("@/lib/logging/signal", () => ({ logCaught }));
vi.mock("../pdfjs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../pdfjs")>()),
  readPdfText,
}));

import { PdfReaderUnavailableError, PdfResourceLimitError } from "../pdfjs";
import { extractPdfText, localExtractText } from "../local-extract";

describe("a PDF past the reader's limits", () => {
  it.each(["memory", "time"] as const)(
    "answers resource-limit for the %s bound, without the error log a broken file gets",
    async (limit) => {
      readPdfText.mockRejectedValueOnce(new PdfResourceLimitError(limit));
      annotate.mockClear();
      logCaught.mockClear();
      const bytes = Buffer.from("%PDF-1.7 large");
      expect(await extractPdfText(bytes)).toEqual({
        ok: false,
        reason: "resource-limit",
      });
      expect(logCaught).not.toHaveBeenCalled();
      expect(annotate).toHaveBeenCalledWith({
        action: { name: "documents.localIndex.resourceLimit" },
        meta: { limit, bytes: bytes.length },
      });
    },
  );

  it.each(["busy", "interrupted"] as const)(
    "passes a reader that was %s up to the job instead of recording an outcome",
    async (kind) => {
      readPdfText.mockRejectedValueOnce(new PdfReaderUnavailableError(kind));
      logCaught.mockClear();
      await expect(
        extractPdfText(Buffer.from("%PDF-1.7 large")),
      ).rejects.toBeInstanceOf(PdfReaderUnavailableError);
      expect(logCaught).not.toHaveBeenCalled();
    },
  );

  it("still answers error for anything else the reader throws", async () => {
    const broken = new Error("Invalid PDF structure");
    broken.name = "InvalidPDFException";
    readPdfText.mockRejectedValueOnce(broken);
    expect(
      await localExtractText(Buffer.from("%PDF-1.7"), "application/pdf"),
    ).toEqual({ ok: false, reason: "error" });
  });
});
