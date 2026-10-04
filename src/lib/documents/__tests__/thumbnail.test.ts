import { Buffer } from "node:buffer";

import { createCanvas } from "@napi-rs/canvas";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));

// Partial mock of the native canvas module: `loadImage` delegates to the real
// decoder by default (so every real-fixture test below is unaffected) and can
// be overridden per-test via `loadImageMock` to simulate a decoded image whose
// dimensions the header sniff could not have known.
const { loadImageMock } = vi.hoisted(() => ({ loadImageMock: vi.fn() }));
vi.mock("@napi-rs/canvas", async (importActual) => {
  const actual = await importActual<typeof import("@napi-rs/canvas")>();
  return {
    ...actual,
    loadImage: (source: Buffer | Uint8Array) =>
      loadImageMock(source) ?? actual.loadImage(source),
  };
});

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
    ).resolves.toEqual({ ok: false, reason: "error" });
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

  it("refuses an oversize image the header sniff missed (post-decode cap)", async () => {
    // Bytes the JPEG sniffer cannot read (no SOI) → the pre-decode guard is
    // skipped and the code falls through to `loadImage`. The decoder is forced
    // to return 30000×30000 = 900 MP, so only the post-decode backstop can
    // catch it. Without that backstop this would OOM the serial worker.
    loadImageMock.mockResolvedValueOnce({ width: 30_000, height: 30_000 });
    await expect(
      generateThumbnail(Buffer.from("desynced jpeg bytes"), "image/jpeg"),
    ).resolves.toEqual({ ok: false, reason: "pixel-cap" });
  });
});
