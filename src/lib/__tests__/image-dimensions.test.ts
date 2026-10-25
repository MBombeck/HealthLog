import { Buffer } from "node:buffer";

import { createCanvas } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";

import { readImageDimensions } from "../image-dimensions";

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

  it("reads a GIF's logical screen", () => {
    const gif = Buffer.from("GIF89a\x25\x00\x17\x00\x00\x00\x00", "latin1");
    expect(readImageDimensions(gif, "image/gif")).toEqual(SIZE);
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
