/**
 * Reads a PDF through its text layer for Antigravity.
 *
 * Antigravity does not take a PDF whole, and the page images of a report with
 * invisible text come out blank. So a PDF in which every page has a text layer
 * is read from that text. A PDF with a scanned page, or one longer than the
 * page cap, returns null and takes the picture path, which covers all its
 * pages.
 */
import type { Buffer } from "node:buffer";

import { detectOcrMimeType } from "@/lib/labs/ocr-upload";

import { readPdfTextLayer, textLayerText } from "./pdf-text-layer";

/** Longest PDF read by its text layer. Longer ones take the picture path. */
const TEXT_LAYER_MAX_PAGES = 50;

/**
 * The full text of a PDF whose pages all have a text layer, or null when the
 * file is not a PDF, a page has no text, or the PDF is too long to read whole.
 */
export async function antigravityPdfTextIfComplete(
  bytes: Buffer,
  surface: string,
): Promise<string | null> {
  if (detectOcrMimeType(bytes) !== "application/pdf") return null;
  const read = await readPdfTextLayer(bytes, TEXT_LAYER_MAX_PAGES, surface);
  if (!read.ok) return null;
  const { layer } = read;
  const complete =
    layer.pagesRead === layer.pageCount && layer.pagesWithoutText.length === 0;
  if (!complete) return null;
  const text = textLayerText(layer);
  return text.trim() ? text : null;
}
