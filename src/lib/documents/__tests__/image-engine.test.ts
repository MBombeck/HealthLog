import { Buffer } from "node:buffer";

import { createCanvas } from "@napi-rs/canvas";
import { describe, expect, it, vi } from "vitest";

import { renderImageThumbnail } from "../image-engine.mjs";

/**
 * What runs in the reader's child for an image upload: decode, check the
 * decoded size once more, draw onto a fresh JPEG. The header walk in the
 * server is a reading of the file; the decoder has the final word, so the
 * decoded size is checked before a canvas is drawn from it.
 */

const OPTIONS = { longEdge: 320, quality: 70, maxPixels: 60_000_000 };

function png(width: number, height: number): Buffer {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#3366cc";
  ctx.fillRect(0, 0, width, height);
  return canvas.toBuffer("image/png");
}

describe("renderImageThumbnail", () => {
  it("draws a decoded image onto a JPEG no longer than the long edge", async () => {
    const outcome = await renderImageThumbnail(png(1200, 800), OPTIONS);
    expect(outcome).toMatchObject({ ok: true, width: 320, height: 213 });
    if (!outcome.ok) return;
    expect(Buffer.from(outcome.jpeg).subarray(0, 2).toString("hex")).toBe(
      "ffd8",
    );
  });

  it("refuses a decoded image larger than the header said, before drawing it", async () => {
    const createCanvasSpy = vi.fn();
    const outcome = await renderImageThumbnail(
      Buffer.from("anything"),
      OPTIONS,
      {
        loadImage: async () => ({ width: 30_000, height: 30_000 }),
        createCanvas: createCanvasSpy,
      },
    );
    expect(outcome).toEqual({ ok: false, reason: "pixel-cap" });
    expect(createCanvasSpy).not.toHaveBeenCalled();
  });

  it("throws what the decoder threw", async () => {
    await expect(
      renderImageThumbnail(Buffer.from("not an image"), OPTIONS),
    ).rejects.toThrow();
  });
});
