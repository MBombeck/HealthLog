/**
 * Local (provider-free) text extraction for the document vault.
 *
 * When NO AI provider is configured — or the user has not consented to one —
 * content search still needs a baseline. This module extracts a PDF's embedded
 * text layer SERVER-SIDE with pdfjs' `getTextContent` (the pure-JS/wasm core,
 * never the native `@napi-rs/canvas`), in milliseconds, with no OCR and no
 * third-party egress.
 *
 * It reads through `./pdfjs`, the one loader `./rasterize-pdf` opens documents
 * with too, so both run the app's own `pdfjs-dist` with the same options. It
 * used to go through `pdf-parse`, which brings a second pdfjs of its own, and
 * the two cannot share a process: both take their worker from
 * `globalThis.pdfjsWorker`, so whichever ran first broke the other ("The API
 * version "6.4.299" does not match the Worker version "5.4.296""). Thumbnails
 * and vision reads failed after a text extraction, and the text extraction
 * failed after a raster.
 * The extracted text feeds the SAME blind, encrypted content index the provider
 * path writes (`upsertContentIndex`), so nothing readable is stored at rest.
 *
 * Digitally-generated PDFs (lab reports, discharge letters, referrals — the
 * clinical common case) carry a real embedded text layer this path reads.
 * Scanned/image-only PDFs and uploaded photos have none: those are read by
 * OCR on this server (`./server-ocr.ts`: the pages rendered, each read by
 * tesseract in the reader's child process), with no provider and no egress,
 * and indexed as `local-ocr`.
 */
import { Buffer } from "node:buffer";

import { annotate } from "@/lib/logging/context";
import { logCaught } from "@/lib/logging/signal";

import {
  PdfReaderUnavailableError,
  PdfResourceLimitError,
  readPdfText,
} from "./pdfjs";
import {
  isServerOcrMime,
  readScanText,
  type ServerOcrOptions,
} from "./server-ocr";

/**
 * Minimum joined text length for a PDF to count as a real text-layer document.
 * Below this a PDF is treated as scanned/empty — a few stray glyphs from a form
 * field or a page number are not a usable index.
 */
export const LOCAL_TEXT_MIN_CHARS = 24;

/**
 * Below this mean word confidence (0 to 100) an OCR read is noise, not text:
 * a photo of a rash or a blank form reads as scattered letters around 10 to
 * 25, a legible page above 70. Indexing the noise would make the document
 * findable by words it does not contain.
 */
const LOCAL_OCR_MIN_CONFIDENCE = 35;

/** Cap on pages parsed — bounds CPU/time on a pathological many-page PDF. */
export const LOCAL_MAX_PAGES = 200;

/** Provenance tag written to `DocumentContentIndex.source` on the local path. */
export type LocalExtractSource = "local-pdf" | "local-ocr";

/**
 * Outcome of a local extraction attempt.
 *   - `ok`          → usable text was recovered (index it).
 *   - `empty`       → a valid document with no usable text, in its text layer
 *                     or by OCR (or OCR is not available in this build).
 *   - `unsupported` → a MIME the local path cannot read at all (or an image on
 *                     a build without OCR); leave un-indexed locally.
 *   - `ocr-failed`  → OCR ran and failed: the engine or the renderer threw, or
 *                     every page crossed the memory or time bound. The same
 *                     bytes fail the same way on this server.
 *   - `cancelled`   → the job ended or the document went away during OCR.
 *   - `resource-limit` → the PDF crossed the reader's memory or time bound
 *                     (`PdfResourceLimitError`): too large or too complex to
 *                     read here. The same bytes cross it again, so it is a
 *                     final answer, as it is for thumbnails.
 *   - `error`       → the file was malformed / unreadable; treat as un-indexed.
 */
export type LocalExtractResult =
  | { ok: true; text: string; source: LocalExtractSource }
  | {
      ok: false;
      reason:
        | "empty"
        | "unsupported"
        | "resource-limit"
        | "error"
        | "ocr-failed"
        | "cancelled";
    };

/**
 * Extract a text-layer PDF's embedded text server-side. Returns `empty` for a
 * scanned/no-text-layer PDF, `resource-limit` for one past the reader's memory
 * or time bound, and `error` for a malformed/encrypted one, so a bad document
 * can never abort the caller (the upload/backfill job just leaves it
 * un-indexed). The one throw is `PdfReaderUnavailableError`: the reader was
 * busy or its process ended for no measured reason, which says nothing about
 * the document, so the job runs again instead of recording an outcome. An `error` leaves a `warn` line naming what
 * pdf.js threw, because the outcome alone does not say why a document stayed
 * out of the index.
 */
export async function extractPdfText(
  buffer: Buffer,
): Promise<LocalExtractResult> {
  let text: string;
  try {
    // Bound the page walk so a pathological many-page PDF costs no more.
    text = (await readPdfText(buffer, LOCAL_MAX_PAGES)).trim();
  } catch (err) {
    if (err instanceof PdfReaderUnavailableError) throw err;
    if (err instanceof PdfResourceLimitError) {
      // Not a fault of the file's bytes being unreadable: they are readable,
      // only not within the bounds this server gives one document.
      annotate({
        action: { name: "documents.localIndex.resourceLimit" },
        meta: { limit: err.limit, bytes: buffer.length },
      });
      return { ok: false, reason: "resource-limit" };
    }
    const errorType = err instanceof Error ? err.name || "Error" : typeof err;
    annotate({
      action: { name: "documents.localIndex.extractFailed" },
      meta: { localExtractError: errorType },
    });
    logCaught("documents.local_extract.failed", err, {
      bytes: buffer.length,
    });
    return { ok: false, reason: "error" };
  }
  if (text.length < LOCAL_TEXT_MIN_CHARS) {
    return { ok: false, reason: "empty" };
  }
  return { ok: true, text, source: "local-pdf" };
}

/**
 * OCR on this server, for a scan or a photo. `fallback` is what the caller
 * answers when OCR has nothing to add: no engine in this build, or no text.
 */
async function readByOcr(
  buffer: Buffer,
  mime: string,
  fallback: "empty" | "unsupported",
  options: ServerOcrOptions,
): Promise<LocalExtractResult> {
  const ocr = await readScanText(buffer, mime, options);
  if (ocr.ok) {
    if (
      ocr.text.trim().length < LOCAL_TEXT_MIN_CHARS ||
      ocr.confidence < LOCAL_OCR_MIN_CONFIDENCE
    ) {
      annotate({
        action: { name: "documents.localIndex.ocrNoText" },
        meta: {
          chars: ocr.text.trim().length,
          confidence: Math.round(ocr.confidence),
        },
      });
      return { ok: false, reason: "empty" };
    }
    return { ok: true, text: ocr.text.trim(), source: "local-ocr" };
  }
  if (ocr.reason === "failed") return { ok: false, reason: "ocr-failed" };
  if (ocr.reason === "cancelled") return { ok: false, reason: "cancelled" };
  if (ocr.reason === "empty") return { ok: false, reason: "empty" };
  return { ok: false, reason: fallback };
}

/**
 * Dispatch local extraction by MIME. A PDF is read by its text layer, and by
 * OCR when it has none; a photo (JPEG, PNG, WebP) by OCR. Anything else is
 * `unsupported`, and the caller falls through to the provider path or leaves
 * the document un-indexed.
 */
export async function localExtractText(
  buffer: Buffer,
  mime: string,
  options: ServerOcrOptions = {},
): Promise<LocalExtractResult> {
  if (mime === "application/pdf") {
    const layer = await extractPdfText(buffer);
    if (layer.ok || layer.reason !== "empty") return layer;
    return readByOcr(buffer, mime, "empty", options);
  }
  if (isServerOcrMime(mime)) {
    return readByOcr(buffer, mime, "unsupported", options);
  }
  return { ok: false, reason: "unsupported" };
}
