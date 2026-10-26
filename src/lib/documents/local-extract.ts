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
 * Scanned/image-only PDFs and uploaded images have NO text layer: local OCR
 * (server-side tesseract + `deu+eng` traineddata baked into the image, plus
 * `@napi-rs/canvas` rasterisation for scanned PDFs) is a deferred follow-up, NOT
 * built here — it carries the only real Alpine/standalone-tracing + CPU cost.
 * Until it lands, those documents stay un-indexed on the local path and are
 * covered by the provider (vision) path whenever one is configured.
 */
import { Buffer } from "node:buffer";

import { annotate } from "@/lib/logging/context";
import { logCaught } from "@/lib/logging/signal";

import {
  PdfReaderUnavailableError,
  PdfResourceLimitError,
  readPdfText,
} from "./pdfjs";

/**
 * Minimum joined text length for a PDF to count as a real text-layer document.
 * Below this a PDF is treated as scanned/empty — a few stray glyphs from a form
 * field or a page number are not a usable index.
 */
export const LOCAL_TEXT_MIN_CHARS = 24;

/** Cap on pages parsed — bounds CPU/time on a pathological many-page PDF. */
const LOCAL_MAX_PAGES = 200;

/** Provenance tag written to `DocumentContentIndex.source` on the local path. */
export type LocalExtractSource = "local-pdf" | "local-ocr";

/**
 * Outcome of a local extraction attempt.
 *   - `ok`          → usable text was recovered (index it).
 *   - `empty`       → a valid document with no usable text layer (scanned PDF);
 *                     a provider vision pass is the only way to read it.
 *   - `unsupported` → a MIME the local path cannot read without OCR (images) or
 *                     at all; leave un-indexed locally.
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
      reason: "empty" | "unsupported" | "resource-limit" | "error";
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
 * Dispatch local extraction by MIME. PDFs go through the text-layer reader;
 * images are the deferred server-OCR seam (see the module header) and return
 * `unsupported` so the caller falls through to the provider path or leaves the
 * document un-indexed.
 */
export async function localExtractText(
  buffer: Buffer,
  mime: string,
): Promise<LocalExtractResult> {
  if (mime === "application/pdf") {
    return extractPdfText(buffer);
  }
  if (mime.startsWith("image/")) {
    // SEAM (NOT DONE): server-side tesseract OCR for scanned images/PDFs is a
    // deferred follow-up. It needs the `deu+eng` traineddata baked into the
    // image and (for scanned PDFs) `@napi-rs/canvas` traced into the standalone
    // build — the only real deployment cost in this area. Until it ships, a
    // no-provider image stays un-indexed locally; a configured vision provider
    // covers it on the AI-first path.
    annotate({
      action: { name: "documents.localIndex.ocrNotImplemented" },
      meta: { mime },
    });
    return { ok: false, reason: "unsupported" };
  }
  return { ok: false, reason: "unsupported" };
}
