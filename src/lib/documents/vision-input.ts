/**
 * The provider-ready payload `prepareVisionInput` (`./ai-route-support.ts`)
 * derives from a stored document, and what it adds to a describe / assist
 * call. Kept apart from the route plumbing so a caller that only shapes the
 * call does not load it.
 */

/** The provider-ready payload derived from a stored document. */
export type VisionInput =
  | {
      ok: true;
      mode: "vision";
      images: {
        mediaType: "image/jpeg" | "image/png" | "image/webp";
        dataBase64: string;
      }[];
      documents: { mediaType: "application/pdf"; dataBase64: string }[];
    }
  /**
   * #1311 — a PDF this server cannot render, for a provider that cannot take
   * it whole, read by its text layer instead (`./pdf-text-layer.ts`).
   * The pages without a text layer (scanned pages) are not in `text`.
   */
  | { ok: true; mode: "text"; text: string }
  | {
      ok: false;
      // Refs #776 — `rasterFailed` (this PDF would not render on a raster-
      // capable build) is distinct from `pdfRendererUnavailable` (this server
      // cannot render PDF pages at all, and the PDF has no text layer to read
      // instead): they need different fixes, so they must not share a label.
      // `readerBusy` is neither: the reader could not take the document now,
      // and the work is tried again.
      reason:
        | "decryptFailed"
        | "fileType"
        | "pdfRendererUnavailable"
        | "rasterFailed"
        | "readerBusy";
    };

/**
 * What a prepared document adds to a describe / assist call: the images and
 * documents of a vision read, or the text of a text-layer read. Those calls
 * take either and read `ocrText` as the text mode.
 */
export function providerInputOf(
  vision: Extract<VisionInput, { ok: true }>,
):
  | Pick<Extract<VisionInput, { mode: "vision" }>, "images" | "documents">
  | { ocrText: string } {
  return vision.mode === "text"
    ? { ocrText: vision.text }
    : { images: vision.images, documents: vision.documents };
}
