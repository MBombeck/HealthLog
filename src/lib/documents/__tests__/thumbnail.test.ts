import { Buffer } from "node:buffer";

import { createCanvas } from "@napi-rs/canvas";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));

// Partial mock of the native canvas module in this process: `loadImage`
// delegates to the real decoder and records every call, so a test can tell
// whether an upload was decoded here rather than in the reader's child.
const { loadImageMock } = vi.hoisted(() => ({ loadImageMock: vi.fn() }));
vi.mock("@napi-rs/canvas", async (importActual) => {
  const actual = await importActual<typeof import("@napi-rs/canvas")>();
  return {
    ...actual,
    loadImage: (source: Buffer | Uint8Array) =>
      loadImageMock(source) ?? actual.loadImage(source),
  };
});

import { gif } from "../../__tests__/gif-fixture";
import { generateThumbnail, THUMB_LONG_EDGE } from "../thumbnail";

/**
 * Preview-thumbnail generation downscales an image (or a PDF's first page) to a
 * small JPEG, bounded to `THUMB_LONG_EDGE` on the long edge, and NEVER throws:
 * an unsupported MIME or malformed bytes resolve to `{ ok: false }` so the card
 * falls back to its kind icon. The re-encode always emits a fresh JPEG (EXIF/GPS
 * stripped by construction).
 */

/** A solid-colour source image at the given size, encoded to the given type. */
function sourceImage(
  width: number,
  height: number,
  mime: "image/jpeg" | "image/png" | "image/webp",
): Buffer {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#3366cc";
  ctx.fillRect(0, 0, width, height);
  if (mime === "image/png") return canvas.toBuffer("image/png");
  if (mime === "image/webp") return canvas.toBuffer("image/webp");
  return canvas.toBuffer("image/jpeg", 90);
}

/** JPEG magic bytes. */
function isJpeg(buf: Buffer): boolean {
  return buf.subarray(0, 2).toString("hex") === "ffd8";
}

describe("generateThumbnail", () => {
  it("downscales a large JPEG to a bounded JPEG preview", async () => {
    const result = await generateThumbnail(
      sourceImage(1200, 800, "image/jpeg"),
      "image/jpeg",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(isJpeg(result.thumbnail.jpeg)).toBe(true);
    expect(Math.max(result.thumbnail.width, result.thumbnail.height)).toBe(
      THUMB_LONG_EDGE,
    );
    // Landscape source keeps its aspect ratio (320 × 213).
    expect(result.thumbnail.width).toBe(THUMB_LONG_EDGE);
    expect(result.thumbnail.height).toBe(213);
  });

  it("renders a PNG source to a JPEG preview", async () => {
    const result = await generateThumbnail(
      sourceImage(640, 640, "image/png"),
      "image/png",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(isJpeg(result.thumbnail.jpeg)).toBe(true);
    expect(result.thumbnail.width).toBe(THUMB_LONG_EDGE);
    expect(result.thumbnail.height).toBe(THUMB_LONG_EDGE);
  });

  it("never upscales a small source", async () => {
    const result = await generateThumbnail(
      sourceImage(100, 60, "image/jpeg"),
      "image/jpeg",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.thumbnail.width).toBe(100);
    expect(result.thumbnail.height).toBe(60);
  });

  it("renders a PDF's first page to a JPEG preview", async () => {
    // A tiny hand-assembled one-page graphics PDF (no text layer needed).
    const content = "0 0 1 rg 20 20 160 160 re f";
    const bodies: string[] = [];
    bodies[1] = "<< /Type /Catalog /Pages 2 0 R >>";
    bodies[2] = "<< /Type /Pages /Kids [3 0 R] /Count 1 >>";
    bodies[3] =
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>";
    bodies[4] = `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`;
    let out = "%PDF-1.4\n";
    const offsets: number[] = [];
    for (let i = 1; i <= 4; i++) {
      offsets[i] = Buffer.byteLength(out, "latin1");
      out += `${i} 0 obj\n${bodies[i]}\nendobj\n`;
    }
    const xrefOffset = Buffer.byteLength(out, "latin1");
    out += "xref\n0 5\n0000000000 65535 f \n";
    for (let i = 1; i <= 4; i++) {
      out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
    }
    out += `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

    const result = await generateThumbnail(
      Buffer.from(out, "latin1"),
      "application/pdf",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(isJpeg(result.thumbnail.jpeg)).toBe(true);
    expect(
      Math.max(result.thumbnail.width, result.thumbnail.height),
    ).toBeLessThanOrEqual(THUMB_LONG_EDGE);
  });

  it("returns { ok: false } for an unsupported MIME type", async () => {
    await expect(
      generateThumbnail(Buffer.from("plain text"), "text/plain"),
    ).resolves.toEqual({ ok: false, reason: "unsupported-type" });
  });

  it("returns { ok: false } and never throws on malformed image bytes", async () => {
    await expect(
      generateThumbnail(Buffer.from("not a real image"), "image/png"),
    ).resolves.toEqual({ ok: false, reason: "size-unreadable" });
  });

  it("returns { ok: false } when a readable header fronts bytes that do not decode", async () => {
    const header = sourceImage(8, 8, "image/png").subarray(0, 40);
    await expect(generateThumbnail(header, "image/png")).resolves.toEqual({
      ok: false,
      reason: "error",
    });
  });

  it("returns { ok: false } on a malformed PDF", async () => {
    await expect(
      generateThumbnail(Buffer.from("not a pdf"), "application/pdf"),
    ).resolves.toEqual({ ok: false, reason: "raster-failed" });
  });

  it("refuses a decompression bomb before decoding (pixel cap)", async () => {
    // A valid PNG signature + IHDR declaring 30000×30000 = 900 MP. The header
    // sniff rejects it BEFORE `loadImage` would allocate a multi-GB bitmap, so
    // the (otherwise incomplete) byte string never reaches the decoder.
    const bomb = Buffer.alloc(24);
    bomb.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    bomb.writeUInt32BE(13, 8); // IHDR length
    bomb.write("IHDR", 12, "ascii");
    bomb.writeUInt32BE(30_000, 16); // width
    bomb.writeUInt32BE(30_000, 20); // height
    await expect(generateThumbnail(bomb, "image/png")).resolves.toEqual({
      ok: false,
      reason: "pixel-cap",
    });
  });

  it("decodes an uploaded image in the reader's child process, not in this one", async () => {
    // The decoder allocates what the file makes it allocate; in the child
    // that ends the child. Nothing of an image upload is decoded here.
    loadImageMock.mockClear();
    const result = await generateThumbnail(
      sourceImage(640, 480, "image/png"),
      "image/png",
    );
    expect(result.ok).toBe(true);
    expect(loadImageMock).not.toHaveBeenCalled();
  });

  /**
   * A JPEG whose frame header declares `width` × `height`, with `fill` 0xFF
   * fill bytes after the start-of-image marker. The standard allows fill
   * bytes before any marker and every decoder skips them.
   */
  function jpegDeclaring(width: number, height: number, fill: number): Buffer {
    const base = sourceImage(16, 16, "image/jpeg");
    const sof = base.indexOf(Buffer.from([0xff, 0xc0]));
    const patched = Buffer.from(base);
    patched.writeUInt16BE(height, sof + 5);
    patched.writeUInt16BE(width, sof + 7);
    return Buffer.concat([
      patched.subarray(0, 2),
      Buffer.alloc(fill, 0xff),
      patched.subarray(2),
    ]);
  }

  it("reads the size of a JPEG with fill bytes before a marker, and refuses a bomb before decoding", async () => {
    loadImageMock.mockClear();
    // 20000×20000 behind one fill byte: the old walker lost its place, read
    // no size and let the decoder allocate 1.6 GB.
    await expect(
      generateThumbnail(jpegDeclaring(20_000, 20_000, 1), "image/jpeg"),
    ).resolves.toEqual({ ok: false, reason: "pixel-cap" });
    await expect(
      generateThumbnail(jpegDeclaring(20_000, 20_000, 3), "image/jpeg"),
    ).resolves.toEqual({ ok: false, reason: "pixel-cap" });
    expect(loadImageMock).not.toHaveBeenCalled();
  });

  it("still previews an ordinary JPEG that carries fill bytes", async () => {
    const result = await generateThumbnail(
      jpegDeclaring(16, 16, 2),
      "image/jpeg",
    );
    expect(result.ok).toBe(true);
  });

  it("refuses a GIF whose frame is far larger than its logical screen, before decoding", async () => {
    loadImageMock.mockClear();
    // A 10 x 10 screen around a 20000 x 20000 frame: the decoder sizes its
    // buffer from the frame.
    const bomb = gif({ width: 10, height: 10 }, [
      { width: 20_000, height: 20_000 },
    ]);
    expect(bomb.length).toBeLessThan(64);
    await expect(generateThumbnail(bomb, "image/gif")).resolves.toEqual({
      ok: false,
      reason: "pixel-cap",
    });
    expect(loadImageMock).not.toHaveBeenCalled();
  });

  it("still previews an ordinary GIF", async () => {
    const result = await generateThumbnail(
      gif({ width: 1, height: 1 }, [{ width: 1, height: 1 }]),
      "image/gif",
    );
    expect(result).toMatchObject({
      ok: true,
      thumbnail: { width: 1, height: 1 },
    });
  });

  it("refuses an image whose size cannot be read instead of decoding it", async () => {
    loadImageMock.mockClear();
    // Start of image, then straight into a scan: no frame header to read.
    const noFrame = Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x08, 1, 2, 3]);
    await expect(generateThumbnail(noFrame, "image/jpeg")).resolves.toEqual({
      ok: false,
      reason: "size-unreadable",
    });
    await expect(
      generateThumbnail(Buffer.from("RIFF0000WEBPVP8Z"), "image/webp"),
    ).resolves.toEqual({ ok: false, reason: "size-unreadable" });
    expect(loadImageMock).not.toHaveBeenCalled();
  });
});
