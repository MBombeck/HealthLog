/**
 * Reading a PDF by its text layer when this server cannot render its pages
 * (#1311).
 *
 * The page renderer needs CPU features some hosts lack
 * (`./native-canvas-support.ts`). There a provider that takes a PDF whole
 * still reads it, but a provider that only takes images gets nothing to look
 * at. A digitally produced report states every word and digit in its text
 * layer, and pdf.js reads that without rendering, so such a PDF is read as
 * text instead. A scanned page has no text layer, and this never pretends it
 * does: a page counts only with `TEXT_LAYER_PAGE_MIN_CHARS` characters of its
 * own, and a PDF with no such page is not read at all.
 *
 * A text read loses what only the picture carries (a table's ruling, a
 * stamp, a handwritten note), and the pages without a text layer are left
 * out. Callers that report a partial read report this one as partial
 * (`isPartialTextLayer`).
 */
import { annotate } from "@/lib/logging/context";

import {
  PdfReaderUnavailableError,
  PdfResourceLimitError,
  readPdfPageTexts,
} from "./pdfjs";

/**
 * Characters other than white space a page's text layer needs before the page
 * counts as read. A scanner that stamps a page number, a date or a fax header
 * onto an image leaves a few; a page of a report, even a short letter, has
 * hundreds.
 */
export const TEXT_LAYER_PAGE_MIN_CHARS = 40;

/** A PDF's usable text layer, page by page. */
export interface PdfTextLayer {
  /** Pages in the PDF. Above the pages looked at when the cap cut it short. */
  pageCount: number;
  /** Pages looked at: the first `pagesRead` of `pageCount`. */
  pagesRead: number;
  /** The pages with a usable text layer (1-based), in order. */
  pages: { page: number; text: string }[];
  /** Pages looked at that have none (a scanned page): not read. */
  pagesWithoutText: number[];
}

export type PdfTextLayerRead =
  | { ok: true; layer: PdfTextLayer }
  | {
      ok: false;
      /**
       * `none`: no page has a usable text layer (a scan). `unreadable`:
       * pdf.js could not open the file, or it crossed the reader's bounds.
       * `busy`: the reader could not take it now; not a verdict on the file.
       */
      reason: "none" | "unreadable" | "busy";
    };

/** Whether one page's text layer is enough to count the page as read. */
export function isUsablePageText(text: string): boolean {
  return text.replace(/\s+/g, "").length >= TEXT_LAYER_PAGE_MIN_CHARS;
}

/** Pages were left out: past the cap, or without a text layer. */
export function isPartialTextLayer(layer: PdfTextLayer): boolean {
  return layer.pagesWithoutText.length > 0 || layer.pageCount > layer.pagesRead;
}

/** The usable pages' text, one page after another. */
export function textLayerText(layer: PdfTextLayer): string {
  return layer.pages.map((p) => p.text).join("\n\n");
}

/**
 * The usable text layer of the first `maxPages` pages. Never throws; `surface`
 * names the caller on the wide event.
 */
export async function readPdfTextLayer(
  bytes: Uint8Array,
  maxPages: number,
  surface: string,
): Promise<PdfTextLayerRead> {
  let read: { pageCount: number; texts: string[] };
  try {
    read = await readPdfPageTexts(bytes, maxPages);
  } catch (err) {
    const busy = err instanceof PdfReaderUnavailableError;
    annotate({
      action: { name: "documents.pdfTextLayer.failed" },
      meta: {
        surface,
        reason: busy
          ? err.kind
          : err instanceof PdfResourceLimitError
            ? "resource_limit"
            : "unreadable",
      },
    });
    return { ok: false, reason: busy ? "busy" : "unreadable" };
  }
  const pages: PdfTextLayer["pages"] = [];
  const pagesWithoutText: number[] = [];
  read.texts.forEach((raw, i) => {
    const text = raw.trim();
    if (isUsablePageText(text)) pages.push({ page: i + 1, text });
    else pagesWithoutText.push(i + 1);
  });
  annotate({
    action: { name: "documents.pdfTextLayer.read" },
    meta: {
      surface,
      pageCount: read.pageCount,
      pagesRead: read.texts.length,
      pagesWithText: pages.length,
    },
  });
  if (pages.length === 0) return { ok: false, reason: "none" };
  return {
    ok: true,
    layer: {
      pageCount: read.pageCount,
      pagesRead: read.texts.length,
      pages,
      pagesWithoutText,
    },
  };
}
