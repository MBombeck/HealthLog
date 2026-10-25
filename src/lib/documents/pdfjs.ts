/**
 * Reading a PDF's text layer, the way the server does it: in a child process
 * under a memory ceiling and a time limit (`./pdf-isolation.ts`), through the
 * one pdf.js loader (`./pdf-engine.mjs`). Rendering goes the same way from
 * `./rasterize-pdf.ts`.
 *
 * This module has no logging of its own, so the end-to-end suite can read
 * report text with it; the callers say what failed.
 */
import { runPdfChild } from "./pdf-isolation";

export { joinTextRuns } from "./pdf-engine.mjs";

/**
 * How long one text read may take. The page walk is capped by the caller
 * (200 pages for the content index); a document still inside this after that
 * many pages is one no reader should wait on.
 */
export const PDF_TEXT_TIMEOUT_MS = 60_000;

/** A document that crossed the memory ceiling or the time limit. */
export class PdfResourceLimitError extends Error {
  override name = "PdfResourceLimitError";
  constructor(readonly limit: "memory" | "time") {
    super(`the PDF crossed the reader's ${limit} limit`);
  }
}

/**
 * The reader could not take the document now: it was busy past the wait this
 * work may spend, or its process ended for a reason that says nothing about
 * the document. Not a verdict on the file; the work is tried again later.
 */
export class PdfReaderUnavailableError extends Error {
  override name = "PdfReaderUnavailableError";
  constructor(readonly kind: "busy" | "interrupted") {
    super(
      kind === "busy"
        ? "the document reader is busy"
        : "the document reader stopped before it answered",
    );
  }
}

/**
 * The text layer of the first `maxPages` pages, one page after another.
 * Throws what pdf.js threw (a malformed file, a password, a page that will
 * not parse) under its own name, `PdfResourceLimitError` when the document
 * crossed a bound, or `PdfReaderUnavailableError` when the reader could not
 * take it now.
 */
export async function readPdfText(
  data: Uint8Array,
  maxPages = Number.POSITIVE_INFINITY,
): Promise<string> {
  const result = await runPdfChild(
    // Infinity does not cross the channel as a page count.
    { op: "text", data, maxPages: Math.min(maxPages, Number.MAX_SAFE_INTEGER) },
    { timeoutMs: PDF_TEXT_TIMEOUT_MS },
  );
  if (result.ok) return result.value;
  if (result.reason === "limit") throw new PdfResourceLimitError(result.limit);
  if (result.reason === "busy" || result.reason === "interrupted") {
    throw new PdfReaderUnavailableError(result.reason);
  }
  const err = new Error(result.message);
  err.name = result.name;
  throw err;
}
