import { Buffer } from "node:buffer";

import { createCanvas } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";

import { readImageDimensions } from "../image-dimensions";
import { gif } from "./gif-fixture";

/**
 * The header walk both the avatar upload and the document thumbnail trust to
 * keep an oversize image away from a decoder. `null` is a refusal at both
 * call sites, so the walk must find the size wherever a decoder would.
 */

function encoded(mime: "image/jpeg" | "image/png" | "image/webp"): Buffer {
  const canvas = createCanvas(37, 23);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#808080";
  ctx.fillRect(0, 0, 37, 23);
  return mime === "image/jpeg"
    ? canvas.toBuffer(mime, 80)
    : canvas.toBuffer(mime as "image/png");
}

const SIZE = { width: 37, height: 23 };

describe("readImageDimensions", () => {
  it("reads PNG, JPEG and WebP as the encoder wrote them", () => {
    expect(readImageDimensions(encoded("image/png"), "image/png")).toEqual(
      SIZE,
    );
    expect(readImageDimensions(encoded("image/jpeg"), "image/jpeg")).toEqual(
      SIZE,
    );
    expect(readImageDimensions(encoded("image/webp"), "image/webp")).toEqual(
      SIZE,
    );
  });

  it("reads a GIF's logical screen when its frames fit inside it", () => {
    expect(
      readImageDimensions(
        gif({ width: 37, height: 23 }, [{ width: 37, height: 23 }]),
        "image/gif",
      ),
    ).toEqual(SIZE);
  });

  it("sizes a GIF by its largest frame, not only its logical screen", () => {
    // The decoder allocates for the frame: 10 x 10 on the screen, 20000 x
    // 20000 in the descriptor was a 1.6 GB decode behind a 100-pixel check.
    expect(
      readImageDimensions(
        gif({ width: 10, height: 10 }, [{ width: 20_000, height: 20_000 }]),
        "image/gif",
      ),
    ).toEqual({ width: 20_000, height: 20_000 });
    // A later frame, an offset, a global colour table and an extension in
    // between are all walked.
    expect(
      readImageDimensions(
        gif({ width: 10, height: 10, colourTable: true }, [
          { width: 4, height: 4 },
          { left: 60_000, top: 5, width: 5_000, height: 3, extension: true },
        ]),
        "image/gif",
      ),
    ).toEqual({ width: 65_000, height: 10 });
  });

  it("refuses a GIF it cannot walk to the end of a frame descriptor", () => {
    const whole = gif({ width: 10, height: 10 }, [{ width: 10, height: 10 }]);
    // Logical screen only: no frame, no size.
    expect(readImageDimensions(whole.subarray(0, 13), "image/gif")).toBeNull();
    // Cut inside the image descriptor.
    expect(readImageDimensions(whole.subarray(0, 18), "image/gif")).toBeNull();
    // A block no decoder knows.
    const unknown = Buffer.from(whole);
    unknown[13] = 0x99;
    expect(readImageDimensions(unknown, "image/gif")).toBeNull();
    // A zero-sized frame.
    expect(
      readImageDimensions(
        gif({ width: 10, height: 10 }, [{ width: 0, height: 10 }]),
        "image/gif",
      ),
    ).toBeNull();
    // Not a GIF signature a decoder accepts.
    const signature = Buffer.from(whole);
    signature.write("GIF80a", 0, "latin1");
    expect(readImageDimensions(signature, "image/gif")).toBeNull();
  });

  it("skips fill bytes, RSTn and TEM before the frame header", () => {
    const jpeg = encoded("image/jpeg");
    const withFill = Buffer.concat([
      jpeg.subarray(0, 2),
      Buffer.from([0xff, 0xff, 0xff, 0x01, 0xff, 0xd3]),
      jpeg.subarray(2),
    ]);
    expect(readImageDimensions(withFill, "image/jpeg")).toEqual(SIZE);
  });

  it("finds no size in a scan or an end of image before any frame header", () => {
    expect(
      readImageDimensions(
        Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 8, 1, 2, 3, 4, 5, 6]),
        "image/jpeg",
      ),
    ).toBeNull();
    expect(
      readImageDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), "image/jpeg"),
    ).toBeNull();
  });

  it("answers null for truncated and zero-sized headers, never throwing", () => {
    const jpeg = encoded("image/jpeg");
    const sof = jpeg.indexOf(Buffer.from([0xff, 0xc0]));
    expect(readImageDimensions(jpeg.subarray(0, sof + 4), "image/jpeg")).toBe(
      null,
    );
    const zero = Buffer.from(encoded("image/png"));
    zero.writeUInt32BE(0, 16);
    expect(readImageDimensions(zero, "image/png")).toBeNull();
    expect(readImageDimensions(Buffer.alloc(3), "image/webp")).toBeNull();
    expect(readImageDimensions(Buffer.alloc(0), "image/gif")).toBeNull();
  });
});
