/**
 * Local (provider-free) text extraction for the document vault.
 *
 * When NO AI provider is configured — or the user has not consented to one —
 * content search still needs a baseline. This module extracts a PDF's embedded
 * text layer SERVER-SIDE with pdfjs' `getTextContent` (the pure-JS/wasm core,
 * never the native `@napi-rs/canvas`), in milliseconds, with no OCR and no
 * third-party egress.
 *
 * It reads through the app's own `pdfjs-dist`, the copy `./rasterize-pdf`
 * renders with. It used to go through `pdf-parse`, which brings a second
 * pdfjs of its own, and the two cannot share a process: both take their
 * worker from `globalThis.pdfjsWorker`, so whichever ran first broke the
 * other ("The API version "6.4.299" does not match the Worker version
 * "5.4.296""). Thumbnails and vision reads failed after a text extraction,
 * and the text extraction failed after a raster.
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

import type { PDFDocumentLoadingTask } from "pdfjs-dist";
import type {
  TextItem,
  TextMarkedContent,
} from "pdfjs-dist/types/src/display/api";

import { annotate } from "@/lib/logging/context";

// pdfjs' module top-level references the browser-only `DOMMatrix` global. A
// STATIC import makes the Turbopack server chunk evaluate that reference at
// instantiation and throw `DOMMatrix is not defined`, taking down every
// route/worker that shares the chunk (the document routes among them). The
// module is therefore loaded lazily inside `extractPdfText` via a runtime
// `import()`. The type imports above are erased at build, so they load
// nothing; they let the compiler check this file against pdfjs' own API.

/**
 * Where a text run sits on the page. pdfjs gives each run a text matrix
 * `[a, b, c, d, x, y]`: `x` and `y` are where the run starts, and `d` is its
 * vertical scale, which for upright text is the font size.
 */
interface RunPosition {
  x: number;
  /** The baseline the run sits on. */
  y: number;
  /** Where the run ends: its start plus its width. */
  end: number;
  fontSize: number;
}

function positionOf(run: TextItem): RunPosition {
  const [, , , scaleY, x = 0, y = 0] = run.transform as number[];
  return {
    x,
    y,
    end: x + run.width,
    fontSize: Math.abs(scaleY ?? 0) || run.height || 1,
  };
}

/**
 * The next run is on a new line when its baseline moved by more than half a
 * font size. Runs on one line can sit a little higher or lower (a superscript,
 * a mixed font), so a small shift does not count.
 */
function startsNewLine(previous: RunPosition, next: RunPosition): boolean {
  return Math.abs(next.y - previous.y) > previous.fontSize / 2;
}

/**
 * Two runs on one line are separate words when the gap between them is wider
 * than a tenth of the font size. Runs that touch, such as a word drawn in two
 * fonts, stay one word.
 */
function leavesWordGap(previous: RunPosition, next: RunPosition): boolean {
  return next.x - previous.end > next.fontSize / 10;
}

/**
 * One page's text: its runs in order, with a line break where a run ends a
 * line or the next one starts a new line, and a space where two runs on one
 * line leave a gap between words.
 */
function pageText(items: Array<TextItem | TextMarkedContent>): string {
  let text = "";
  let previous: RunPosition | null = null;

  for (const item of items) {
    // Marked-content markers carry no text.
    if (!("str" in item)) continue;
    const position = positionOf(item);

    if (previous && !text.endsWith("\n")) {
      if (startsNewLine(previous, position)) {
        text += "\n";
      } else if (leavesWordGap(previous, position) && !/\s$/.test(text)) {
        text += " ";
      }
    }
    text += item.str;
    if (item.hasEOL && !text.endsWith("\n")) text += "\n";

    previous = position;
  }
  return text;
}

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
 * just leaves it un-indexed).
 */
export async function extractPdfText(
  buffer: Buffer,
): Promise<LocalExtractResult> {
  let task: PDFDocumentLoadingTask | null = null;
  try {
    // Lazy load: keeps pdfjs/DOMMatrix out of the eager server chunk (see the
    // import-site note). Resolved at first PDF extraction, then module-cached.
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    task = pdfjs.getDocument({
      data: new Uint8Array(buffer),
      verbosity: 0, // VerbosityLevel.ERRORS — no console spam on odd PDFs.
      useSystemFonts: false,
    });
    const doc = await task.promise;
    // Bound the page walk so a pathological many-page PDF costs no more.
    const pageCount = Math.min(doc.numPages, LOCAL_MAX_PAGES);
    const pages: string[] = [];
    for (let n = 1; n <= pageCount; n++) {
      const page = await doc.getPage(n);
      try {
        pages.push(pageText((await page.getTextContent()).items));
      } finally {
        page.cleanup();
      }
    }
    const text = pages.join("\n").trim();
    if (text.length < LOCAL_TEXT_MIN_CHARS) {
      return { ok: false, reason: "empty" };
    }
    return { ok: true, text, source: "local-pdf" };
  } catch {
    return { ok: false, reason: "error" };
  } finally {
    if (task) {
      try {
        await task.destroy();
      } catch {
        // Best-effort teardown; a destroy failure must not mask the result.
      }
    }
  }
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
