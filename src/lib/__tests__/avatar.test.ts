import { describe, expect, it } from "vitest";

import {
  AVATAR_MAX_BYTES,
  buildAvatarUrl,
  detectAvatarMimeType,
  readAvatarDimensions,
} from "@/lib/avatar";

/** Single 1×1 white PNG. */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABXvMqOgAAAABJRU5ErkJggg==",
  "base64",
);

/** Minimal JPEG: SOI + APP0 + SOF0(1×1) + EOI. */
const JPEG_1X1 = Buffer.from([
  0xff, 0xd8, // SOI
  0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00,
  0x01, 0x00, 0x01, 0x00, 0x00,
  0xff, 0xc0, 0x00, 0x0b, 0x08,
  0x00, 0x01, // height = 1
  0x00, 0x01, // width = 1
  0x01, 0x01, 0x11, 0x00,
  0xff, 0xd9, // EOI
]);

/**
 * Minimal lossy WebP: RIFF/WEBP + VP8 header with width=1, height=1.
 * The size + offset layout matches the parser in `readWebpDimensions`.
 */
const WEBP_VP8_1X1 = (() => {
  const b = Buffer.alloc(32);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(24, 4); // file size (informational)
  b.write("WEBP", 8, "ascii");
  b.write("VP8 ", 12, "ascii");
  b.writeUInt32LE(16, 16); // chunk size (informational)
  // VP8 frame header: 3-byte frame tag + 0x9D 0x01 0x2A signature +
  // 16-bit little-endian width / height with the top 2 bits reserved.
  b.writeUInt8(0x9d, 23);
  b.writeUInt8(0x01, 24);
  b.writeUInt8(0x2a, 25);
  b.writeUInt16LE(1, 26); // width = 1
  b.writeUInt16LE(1, 28); // height = 1
  return b;
})();

describe("detectAvatarMimeType", () => {
  it("identifies a PNG signature", () => {
    expect(detectAvatarMimeType(PNG_1X1)).toBe("image/png");
  });

  it("identifies a JPEG signature", () => {
    expect(detectAvatarMimeType(JPEG_1X1)).toBe("image/jpeg");
  });

  it("identifies a WebP signature", () => {
    expect(detectAvatarMimeType(WEBP_VP8_1X1)).toBe("image/webp");
  });

  it("returns null for an unsupported MIME", () => {
    expect(detectAvatarMimeType(Buffer.from("not an image, just text"))).toBe(
      null,
    );
  });

  it("returns null for a buffer too short to sniff", () => {
    expect(detectAvatarMimeType(Buffer.from([0xff, 0xd8]))).toBe(null);
  });
});

describe("readAvatarDimensions", () => {
  it("reads PNG dimensions from IHDR", () => {
    expect(readAvatarDimensions(PNG_1X1, "image/png")).toEqual({
      width: 1,
      height: 1,
    });
  });

  it("reads JPEG dimensions from the first SOF marker", () => {
    expect(readAvatarDimensions(JPEG_1X1, "image/jpeg")).toEqual({
      width: 1,
      height: 1,
    });
  });

  it("reads VP8 WebP dimensions", () => {
    expect(readAvatarDimensions(WEBP_VP8_1X1, "image/webp")).toEqual({
      width: 1,
      height: 1,
    });
  });
});

describe("buildAvatarUrl", () => {
  it("returns a relative URL with a unix-ms cache-bust suffix", () => {
    const ts = new Date(1_700_000_000_000);
    expect(buildAvatarUrl("user-abc", ts)).toBe(
      "/api/user/avatar/user-abc?v=1700000000000",
    );
  });
});

describe("AVATAR_MAX_BYTES", () => {
  it("caps uploads at 2 MiB", () => {
    expect(AVATAR_MAX_BYTES).toBe(2 * 1024 * 1024);
  });
});
