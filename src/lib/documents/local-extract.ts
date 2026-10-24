/**
 * Local (provider-free) text extraction for the document vault.
 *
 * When NO AI provider is configured — or the user has not consented to one —
 * content search still needs a baseline. This module extracts a PDF's embedded
 * text layer SERVER-SIDE through the app's one pdf.js (`./pdfjs`; reading the
 * text layer never draws, so the native canvas does no work here), in
 * milliseconds, with no OCR and no third-party egress.
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

import { readPdfText } from "./pdfjs";

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
 *   - `error`       → the file was malformed / unreadable; treat as un-indexed.
 */
export type LocalExtractResult =
  | { ok: true; text: string; source: LocalExtractSource }
  | { ok: false; reason: "empty" | "unsupported" | "error" };

/**
 * Extract a text-layer PDF's embedded text server-side. Returns `empty` for a
 * scanned/no-text-layer PDF and `error` for a malformed/encrypted one — never
 * throws, so a bad document can never abort the caller (the upload/backfill job
 * just leaves it un-indexed). An `error` leaves a `warn` line naming what
 * pdf.js threw, because the outcome alone does not say why a document stayed
 * out of the index.
 */
export async function extractPdfText(
  buffer: Buffer,
): Promise<LocalExtractResult> {
  let raw: string;
  try {
    // Bounded page walk; pages joined by a blank line, with no page markers,
    // so only real document text is tokenised.
    raw = await readPdfText(buffer, LOCAL_MAX_PAGES);
  } catch (err) {
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
  const text = raw.trim();
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
