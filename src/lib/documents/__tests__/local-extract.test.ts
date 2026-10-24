import { describe, expect, it, vi } from "vitest";
import { jsPDF } from "jspdf";

/**
 * Local, provider-free text extraction. Pins: a real text-layer PDF yields its
 * text with source "local-pdf" (no provider, no OCR); a PDF below the min-chars
 * gate is treated as empty (scanned); an image is the deferred-OCR seam
 * (unsupported); malformed bytes fail closed to "error" without throwing.
 */

const { annotate, logCaught } = vi.hoisted(() => ({
  annotate: vi.fn(),
  logCaught: vi.fn(),
}));
vi.mock("@/lib/logging/context", () => ({ annotate }));
vi.mock("@/lib/logging/signal", () => ({ logCaught }));

import {
  extractPdfText,
  localExtractText,
  LOCAL_TEXT_MIN_CHARS,
} from "../local-extract";

/** Build a real text-layer PDF (jsPDF is isomorphic; Helvetica text layer). */
function textLayerPdf(lines: string[]): Buffer {
  const doc = new jsPDF();
  let y = 10;
  for (const line of lines) {
    doc.text(line, 10, y);
    y += 10;
  }
  return Buffer.from(doc.output("arraybuffer"));
}

describe("extractPdfText", () => {
  it("reads a text-layer PDF's embedded text as source local-pdf", async () => {
    const pdf = textLayerPdf([
      "Haemoglobin 14.2 g/dL Cholesterol total 190 mg/dL",
      "Patient report creatinine glucose fasting values",
    ]);
    const result = await extractPdfText(pdf);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source).toBe("local-pdf");
      expect(result.text).toContain("Haemoglobin");
      expect(result.text).toContain("creatinine");
      // The default "-- N of M --" page marker must not leak into the text.
      expect(result.text).not.toMatch(/-- \d+ of \d+ --/);
    }
  });

  it("treats a PDF below the min-chars gate as empty (scanned proxy)", async () => {
    const pdf = textLayerPdf(["x"]);
    expect("x".length).toBeLessThan(LOCAL_TEXT_MIN_CHARS);
    const result = await extractPdfText(pdf);
    expect(result).toEqual({ ok: false, reason: "empty" });
  });

  it("fails closed to error on malformed bytes without throwing", async () => {
    const result = await extractPdfText(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
    expect(result).toEqual({ ok: false, reason: "error" });
  });

  // #1277: a failed read used to leave nothing behind but `error`, which
  // the index job reports under another name. It now says what pdf.js threw.
  it("says why a read failed", async () => {
    annotate.mockClear();
    logCaught.mockClear();
    const bytes = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    await extractPdfText(bytes);
    expect(logCaught).toHaveBeenCalledOnce();
    const [action, error, meta] = logCaught.mock.calls[0]!;
    expect(action).toBe("documents.local_extract.failed");
    expect(error).toBeInstanceOf(Error);
    expect(meta).toEqual({ bytes: 8 });
    expect(annotate).toHaveBeenCalledWith({
      action: { name: "documents.localIndex.extractFailed" },
      meta: { localExtractError: (error as Error).name },
    });
  });

  it("reads a PDF with an owner password only, and refuses one that needs a password to open", async () => {
    const owned = new jsPDF({
      encryption: { ownerPassword: "owner", userPermissions: ["print"] },
    });
    owned.text("Encrypted lab report haemoglobin creatinine glucose", 10, 10);
    const readable = await extractPdfText(
      Buffer.from(owned.output("arraybuffer")),
    );
    expect(readable).toMatchObject({ ok: true, source: "local-pdf" });

    logCaught.mockClear();
    const locked = new jsPDF({
      encryption: {
        userPassword: "user",
        ownerPassword: "owner",
        userPermissions: ["print"],
      },
    });
    locked.text("Encrypted lab report haemoglobin creatinine glucose", 10, 10);
    const result = await extractPdfText(
      Buffer.from(locked.output("arraybuffer")),
    );
    expect(result).toEqual({ ok: false, reason: "error" });
    expect((logCaught.mock.calls[0]![1] as Error).name).toBe(
      "PasswordException",
    );
  });
});

describe("localExtractText", () => {
  it("routes application/pdf through the text-layer reader", async () => {
    const pdf = textLayerPdf([
      "Discharge letter diagnosis medication dosage instructions",
    ]);
    const result = await localExtractText(pdf, "application/pdf");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.source).toBe("local-pdf");
  });

  it("returns unsupported for images (deferred server-OCR seam)", async () => {
    const result = await localExtractText(
      Buffer.from([0xff, 0xd8]),
      "image/jpeg",
    );
    expect(result).toEqual({ ok: false, reason: "unsupported" });
  });

  it("returns unsupported for any other MIME", async () => {
    const result = await localExtractText(Buffer.from([0]), "text/plain");
    expect(result).toEqual({ ok: false, reason: "unsupported" });
  });
});
