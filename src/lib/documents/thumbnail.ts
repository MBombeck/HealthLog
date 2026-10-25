/**
 * Server-side preview-thumbnail generation for the document vault.
 *
 * Turns a stored original into a small JPEG the vault card renders at its
 * leading edge: an image is decoded + downscaled; a PDF's FIRST page is
 * rasterised (via `rasterizePdf`, bounded to one page) then downscaled; every
 * other MIME type has no preview (the card keeps its kind icon).
 *
 * `@napi-rs/canvas` + pdfjs are pulled LAZILY via runtime `import()` — pdfjs's
 * module top-level references the browser-only `DOMMatrix` global, so a STATIC
 * import would make the Turbopack server chunk evaluate that reference at
 * instantiation and throw `DOMMatrix is not defined`, taking down every
 * route/worker sharing the chunk. The lazy import (the exact pattern
 * `rasterize-pdf.ts` documents) keeps both out of the eager chunk. Rendering
 * is pure local compute — no network, nothing written to disk.
 *
 * Security: the thumbnail is produced by decode → draw onto a FRESH canvas →
 * `toBuffer("image/jpeg")`. A canvas re-encode emits a brand-new JPEG carrying
 * NO source metadata (EXIF, GPS, orientation, maker notes are all dropped), so
 * the preview is metadata-free by construction — a defence-in-depth bonus over
 * the original blob.
 *
 * NEVER throws: a malformed / unrenderable image or PDF, a missing native
 * binary, or any render error resolves to `{ ok: false }`, and the caller
 * leaves the document without a thumbnail (the card falls back to its kind
 * icon). This preserves the "a bad document never aborts an upload/backfill"
 * contract.
 */
import { Buffer } from "node:buffer";

import { nativeCanvasSupported } from "./native-canvas-support";

import { rasterizePdf } from "@/lib/documents/rasterize-pdf";
import {
  readImageDimensions,
  type DimensionedImageMime,
} from "@/lib/image-dimensions";
import { annotate } from "@/lib/logging/context";

/** Longest-edge pixel cap for the preview — a legible card tile at ~10-25 KB. */
export const THUMB_LONG_EDGE = 320;

/** JPEG quality (0-100). q70 keeps the preview crisp at a small byte cost. */
export const THUMB_QUALITY = 70;

/**
 * Source-pixel ceiling enforced BEFORE decode. `loadImage` allocates the full
 * decoded bitmap (W×H×4 bytes) before we downscale, so a tiny, highly-compressed
 * image that declares enormous dimensions — a decompression bomb — would balloon
 * the decode buffer and OOM the serial thumbnail worker, crash-looping it and
 * denying background-job processing to every tenant. 60 MP (~240 MB RGBA) admits
 * any real photo or high-DPI document scan (a 600-DPI A4 is ~35 MP) while refusing
 * the multi-hundred-MP bombs. The header sniff below reads the declared size
 * cheaply; anything over the cap gets no preview.
 */
export const MAX_SOURCE_PIXELS = 60_000_000;

/** Image MIME types the canvas decoder can downscale directly. */
const THUMBNAILABLE_IMAGE_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

/**
 * A source image's pixel count (width × height) from its container header,
 * WITHOUT decoding the bitmap — the guard that keeps a decompression bomb out
 * of `loadImage`. `null` when the header cannot be read, which the caller
 * treats as a refusal: the decoder reads headers more leniently than any
 * hand-written walker, so an unreadable size is no evidence of a small one.
 */
function sniffSourcePixels(bytes: Buffer, mimeType: string): number | null {
  if (!THUMBNAILABLE_IMAGE_MIMES.has(mimeType)) return null;
  const size = readImageDimensions(bytes, mimeType as DimensionedImageMime);
  return size ? size.width * size.height : null;
}

/** The generated preview plus its decoded dimensions (for `Content-Length`). */
export interface Thumbnail {
  jpeg: Buffer;
  width: number;
  height: number;
}

/**
 * Why no preview was made. `unsupported-type` is the expected answer for an
 * Office file or a text document; every other reason means a preview should
 * have existed, so the thumbnail job logs it as a warning.
 */
export type ThumbnailSkipReason =
  | "unsupported-type"
  | "native-canvas-unsupported"
  | "pixel-cap"
  | "size-unreadable"
  | "raster-failed"
  | "resource-limit"
  | "empty-render"
  | "error";

/** Best-effort generation outcome — never an exception. */
export type ThumbnailResult =
  | { ok: true; thumbnail: Thumbnail }
  | { ok: false; reason: ThumbnailSkipReason };

// Minimal structural types for the slice of `@napi-rs/canvas` this module uses.
// A type-only shape (erased at build) so we never eagerly evaluate the module
// for its types; the real module is pulled at runtime via `import()`.
interface CanvasImage {
  width: number;
  height: number;
}
interface CanvasContext2D {
  drawImage(
    image: CanvasImage,
    dx: number,
    dy: number,
    dWidth: number,
    dHeight: number,
  ): void;
}
interface CanvasLike {
  getContext(type: "2d"): CanvasContext2D;
  toBuffer(mime: "image/jpeg", quality?: number): Buffer;
}
interface NapiCanvasModule {
  createCanvas(width: number, height: number): CanvasLike;
  loadImage(source: Buffer | Uint8Array): Promise<CanvasImage>;
}

/**
 * Downscale a decoded image onto a fresh JPEG whose long edge is ≤
 * `THUMB_LONG_EDGE` (never upscaled). Shared by the image and PDF paths.
 */
function drawScaledJpeg(
  napi: NapiCanvasModule,
  image: CanvasImage,
): Thumbnail | null {
  const srcW = image.width;
  const srcH = image.height;
  if (srcW <= 0 || srcH <= 0) return null;
  const longEdge = Math.max(srcW, srcH);
  // Cap the long edge, never upscale (scale ≤ 1).
  const scale = Math.min(1, THUMB_LONG_EDGE / longEdge);
  const width = Math.max(1, Math.round(srcW * scale));
  const height = Math.max(1, Math.round(srcH * scale));
  const canvas = napi.createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0, width, height);
  const jpeg = canvas.toBuffer("image/jpeg", THUMB_QUALITY);
  if (jpeg.byteLength === 0) return null;
  return { jpeg, width, height };
}

/**
 * Generate a small JPEG preview for a stored document, or `{ ok: false }` when
 * the type is unsupported or rendering fails. Never throws.
 */
export async function generateThumbnail(
  bytes: Buffer,
  mimeType: string,
): Promise<ThumbnailResult> {
  try {
    // CPU-feature gate BEFORE the module ever loads: the bundled Skia x64
    // build uses AVX2, and on a CPU without it the first canvas call is an
    // uncatchable SIGILL that kills the whole process (crash-loop incident on
    // a Celeron NAS). With the gate closed, thumbnails simply do not exist —
    // the vault falls back to kind icons.
    if (!nativeCanvasSupported()) {
      annotate({
        action: { name: "documents.thumbnail.rejected" },
        meta: { reason: "native_canvas_unsupported" },
      });
      return { ok: false, reason: "native-canvas-unsupported" };
    }
    // Lazy import: keeps @napi-rs/canvas (+ transitively pdfjs on the PDF path)
    // out of the eager server chunk. Resolved on first generation, then cached.
    const napi =
      (await import("@napi-rs/canvas")) as unknown as NapiCanvasModule;

    if (THUMBNAILABLE_IMAGE_MIMES.has(mimeType)) {
      // Refuse a decompression bomb BEFORE `loadImage` allocates the bitmap,
      // and refuse an image whose size cannot be read: that one would reach
      // the decoder with no ceiling at all.
      const pixels = sniffSourcePixels(bytes, mimeType);
      if (pixels === null) {
        annotate({
          action: { name: "documents.thumbnail.rejected" },
          meta: { source: "image", reason: "size_unreadable" },
        });
        return { ok: false, reason: "size-unreadable" };
      }
      if (pixels > MAX_SOURCE_PIXELS) {
        annotate({
          action: { name: "documents.thumbnail.rejected" },
          meta: { source: "image", reason: "pixel_cap", pixels },
        });
        return { ok: false, reason: "pixel-cap" };
      }
      const image = await napi.loadImage(bytes);
      // Post-decode backstop: should a decoder ever read a larger frame than
      // the header walk did, the decoded size is checked again before the
      // bitmap is drawn.
      if (image.width * image.height > MAX_SOURCE_PIXELS) {
        annotate({
          action: { name: "documents.thumbnail.rejected" },
          meta: {
            source: "image",
            reason: "pixel_cap_post_decode",
            pixels: image.width * image.height,
          },
        });
        return { ok: false, reason: "pixel-cap" };
      }
      const thumb = drawScaledJpeg(napi, image);
      if (!thumb) return { ok: false, reason: "empty-render" };
      annotate({
        action: { name: "documents.thumbnail.ok" },
        meta: { source: "image", width: thumb.width, height: thumb.height },
      });
      return { ok: true, thumbnail: thumb };
    }

    if (mimeType === "application/pdf") {
      // Page 1 only — a preview never renders the whole document.
      const raster = await rasterizePdf(bytes, 1);
      if (!raster.ok && raster.reason === "resource-limit") {
        // The page exhausted the renderer's memory or time bound; the same
        // bytes will again, so the job records it as final.
        return { ok: false, reason: "resource-limit" };
      }
      if (!raster.ok || raster.images.length === 0) {
        return { ok: false, reason: "raster-failed" };
      }
      const pageJpeg = Buffer.from(raster.images[0]!.dataBase64, "base64");
      const image = await napi.loadImage(pageJpeg);
      const thumb = drawScaledJpeg(napi, image);
      if (!thumb) return { ok: false, reason: "empty-render" };
      annotate({
        action: { name: "documents.thumbnail.ok" },
        meta: { source: "pdf", width: thumb.width, height: thumb.height },
      });
      return { ok: true, thumbnail: thumb };
    }

    // Every other MIME (Office/text/TIFF/HEIC/XML/JSON) — no preview.
    return { ok: false, reason: "unsupported-type" };
  } catch (err) {
    annotate({
      action: { name: "documents.thumbnail.failed" },
      meta: {
        mimeType,
        reason: err instanceof Error ? err.name : "unknown",
        message: err instanceof Error ? err.message.slice(0, 300) : String(err),
      },
    });
    return { ok: false, reason: "error" };
  }
}
