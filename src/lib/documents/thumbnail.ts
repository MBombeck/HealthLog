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
 * Read a source image's pixel count (width × height) from its container header
 * WITHOUT decoding the bitmap — the guard that keeps a decompression bomb out of
 * `loadImage`. Covers the four thumbnailable formats. Returns null when the
 * header can't be read (a malformed file `loadImage` will itself reject, or a
 * format we don't pre-screen); a bomb necessarily carries a parseable header
 * declaring huge dimensions, so a null here is never the bomb case.
 */
function sniffSourcePixels(bytes: Buffer, mimeType: string): number | null {
  try {
    switch (mimeType) {
      case "image/png": {
        // 8-byte signature + 4-byte length + "IHDR" → width@16, height@20 (BE).
        if (bytes.length < 24 || bytes.readUInt32BE(12) !== 0x49484452)
          return null;
        return bytes.readUInt32BE(16) * bytes.readUInt32BE(20);
      }
      case "image/gif": {
        // "GIF8" + logical-screen descriptor: width@6, height@8 (uint16 LE).
        if (bytes.length < 10) return null;
        return bytes.readUInt16LE(6) * bytes.readUInt16LE(8);
      }
      case "image/jpeg":
        return sniffJpegPixels(bytes);
      case "image/webp":
        return sniffWebpPixels(bytes);
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/** Walk JPEG marker segments to the first Start-Of-Frame and read its W×H. */
function sniffJpegPixels(bytes: Buffer): number | null {
  if (bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8) return null; // SOI
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1]!;
    const segLen = bytes.readUInt16BE(offset + 2);
    if (segLen < 2) return null;
    // SOF0-15 carry dimensions, EXCEPT DHT (C4), JPG (C8), DAC (CC).
    const isSof =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (isSof) {
      const height = bytes.readUInt16BE(offset + 5);
      const width = bytes.readUInt16BE(offset + 7);
      return width * height;
    }
    offset += 2 + segLen;
  }
  return null;
}

/** Read W×H from a WebP RIFF header (VP8 lossy / VP8L lossless / VP8X ext). */
function sniffWebpPixels(bytes: Buffer): number | null {
  if (bytes.length < 30) return null;
  if (bytes.readUInt32BE(0) !== 0x52494646) return null; // "RIFF"
  if (bytes.readUInt32BE(8) !== 0x57454250) return null; // "WEBP"
  const fourcc = bytes.toString("ascii", 12, 16);
  if (fourcc === "VP8 ") {
    // Lossy: 14-bit width/height (LE) at 26/28.
    const w = bytes.readUInt16LE(26) & 0x3fff;
    const h = bytes.readUInt16LE(28) & 0x3fff;
    return w * h;
  }
  if (fourcc === "VP8L") {
    // Lossless: 14-bit each, bit-packed after the 1-byte signature at 21.
    const b0 = bytes[21]!;
    const b1 = bytes[22]!;
    const b2 = bytes[23]!;
    const b3 = bytes[24]!;
    const w = 1 + (((b1 & 0x3f) << 8) | b0);
    const h = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
    return w * h;
  }
  if (fourcc === "VP8X") {
    // Extended: 24-bit LE (stored value + 1) width@24, height@27.
    const w = 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16));
    const h = 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16));
    return w * h;
  }
  return null;
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
  | "raster-failed"
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
      // Refuse a decompression bomb BEFORE `loadImage` allocates the bitmap.
      const pixels = sniffSourcePixels(bytes, mimeType);
      if (pixels !== null && pixels > MAX_SOURCE_PIXELS) {
        annotate({
          action: { name: "documents.thumbnail.rejected" },
          meta: { source: "image", reason: "pixel_cap", pixels },
        });
        return { ok: false, reason: "pixel-cap" };
      }
      const image = await napi.loadImage(bytes);
      // Post-decode backstop: the header sniff returns null on any marker
      // desync (a malformed-but-decodable JPEG), falling through to here with
      // NO ceiling. Re-check the DECODED dimensions so such a source can't
      // bypass the cap and OOM the serial worker.
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
