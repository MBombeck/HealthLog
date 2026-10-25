// @ts-check
/**
 * Decoding an uploaded image into the vault's preview thumbnail.
 *
 * The server never runs this in its own process. An image decoder allocates
 * the whole bitmap before anything can look at it, and the size it allocates
 * is whatever the file declares in a place the decoder chooses: a GIF frame
 * descriptor once reached a 1.6 GB decode behind a header check that only
 * read the logical screen. The header check (`../image-dimensions.ts`) still
 * refuses what it can see before a child is started; this module is what
 * runs in that child (`./pdf-child.mjs`, under the memory ceiling and time
 * limit of `./pdf-isolation.ts`), so a decoder surprise ends the child and
 * not the server.
 *
 * Plain JavaScript for the same reason as `./pdf-engine.mjs`: the child runs
 * it with plain Node from the checkout and the standalone image alike.
 */
import { Buffer } from "node:buffer";

/**
 * @typedef {object} ImageThumbnailOptions
 * @property {number} longEdge The preview's longest side; never upscaled.
 * @property {number} quality JPEG quality, 0 to 100.
 * @property {number} maxPixels The most pixels a decoded source may have.
 */

/**
 * @typedef {{ ok: true; jpeg: Uint8Array; width: number; height: number }
 *   | { ok: false; reason: "pixel-cap" | "empty-render" }} ImageThumbnailOutcome
 */

/**
 * The slice of `@napi-rs/canvas` used here; the suites pass a stand-in.
 *
 * @typedef {object} CanvasModule
 * @property {(source: Buffer) => Promise<{ width: number; height: number }>} loadImage
 * @property {(width: number, height: number) => {
 *   getContext(type: "2d"): { drawImage(image: unknown, dx: number, dy: number, dw: number, dh: number): void };
 *   toBuffer(mime: "image/jpeg", quality?: number): Buffer;
 * }} createCanvas
 */

/**
 * Decode an image and draw it onto a fresh JPEG no longer than
 * `options.longEdge` on its long side. The re-encode carries none of the
 * source's metadata. Throws what the decoder threw.
 *
 * @param {Uint8Array} data
 * @param {ImageThumbnailOptions} options
 * @param {CanvasModule} [canvasModule]
 * @returns {Promise<ImageThumbnailOutcome>}
 */
export async function renderImageThumbnail(data, options, canvasModule) {
  const napi =
    canvasModule ??
    /** @type {CanvasModule} */ (
      /** @type {unknown} */ (await import("@napi-rs/canvas"))
    );
  const image = await napi.loadImage(
    Buffer.from(data.buffer, data.byteOffset, data.byteLength),
  );
  // The decoded size again, before a canvas of that size is drawn from: the
  // header check is a reading of the file, the decoder had the final word.
  if (image.width * image.height > options.maxPixels) {
    return { ok: false, reason: "pixel-cap" };
  }
  if (image.width <= 0 || image.height <= 0) {
    return { ok: false, reason: "empty-render" };
  }
  const scale = Math.min(
    1,
    options.longEdge / Math.max(image.width, image.height),
  );
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const canvas = napi.createCanvas(width, height);
  canvas.getContext("2d").drawImage(image, 0, 0, width, height);
  const jpeg = canvas.toBuffer("image/jpeg", options.quality);
  if (jpeg.byteLength === 0) return { ok: false, reason: "empty-render" };
  return { ok: true, jpeg: new Uint8Array(jpeg), width, height };
}
