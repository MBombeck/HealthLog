import { Buffer } from "node:buffer";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BodyTooLargeError,
  detectOcrMimeType,
  OCR_MAX_BYTES,
  readBoundedBody,
} from "../ocr-upload";

/** Pad a magic-byte header out to the 12-byte minimum the sniffer needs. */
function withMagic(bytes: number[]): Buffer {
  const buf = Buffer.alloc(16);
  buf.set(bytes, 0);
  return buf;
}

describe("detectOcrMimeType", () => {
  it("recognises a PDF by the %PDF- header", () => {
    expect(detectOcrMimeType(withMagic([0x25, 0x50, 0x44, 0x46, 0x2d]))).toBe(
      "application/pdf",
    );
  });

  it("recognises a JPEG", () => {
    expect(detectOcrMimeType(withMagic([0xff, 0xd8, 0xff]))).toBe("image/jpeg");
  });

  it("recognises a PNG", () => {
    expect(
      detectOcrMimeType(
        withMagic([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      ),
    ).toBe("image/png");
  });

  it("recognises a WebP (RIFF....WEBP)", () => {
    const buf = Buffer.alloc(16);
    buf.write("RIFF", 0, "ascii");
    buf.write("WEBP", 8, "ascii");
    expect(detectOcrMimeType(buf)).toBe("image/webp");
  });

  it("returns null for an unrecognised / unsupported format", () => {
    expect(detectOcrMimeType(withMagic([0x00, 0x01, 0x02, 0x03]))).toBeNull();
    // HEIC is deliberately NOT supported in v1.
    expect(detectOcrMimeType(Buffer.from("ftypheic", "ascii"))).toBeNull();
  });

  it("caps uploads at 12 MiB", () => {
    expect(OCR_MAX_BYTES).toBe(12 * 1024 * 1024);
  });
});

describe("readBoundedBody", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("cancels immediately when a chunk crosses the byte cap", async () => {
    let pulls = 0;
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          if (pulls === 1) {
            controller.enqueue(new Uint8Array(5));
            return;
          }
          controller.error(new Error("reader continued after overflow"));
        },
        cancel,
      },
      { highWaterMark: 0 },
    );

    await expect(readBoundedBody(stream, 4)).rejects.toBeInstanceOf(
      BodyTooLargeError,
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(pulls).toBe(1);
  });

  it("cancels a non-ending read when its AbortSignal fires", async () => {
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
      cancel,
    });
    const abort = new AbortController();

    const result = readBoundedBody(stream, 16, { signal: abort.signal });
    abort.abort();
    try {
      controller!.close();
    } catch {
      // A correctly cancelled stream is already closed.
    }

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels a slow read at an absolute deadline", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
        setTimeout(() => {
          try {
            controller.close();
          } catch {
            // A deadline cancellation closes it first.
          }
        }, 200);
      },
      cancel,
    });

    const result = readBoundedBody(stream, 16, {
      deadline: Date.now() + 100,
    });
    const assertion = expect(result).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.advanceTimersByTimeAsync(200);
    await assertion;
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("combines every independently aligned chunk", async () => {
    const first = new Uint8Array([1, 2]);
    const second = new Uint8Array([3, 4]);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(first);
        controller.enqueue(second);
        controller.close();
      },
    });

    await expect(readBoundedBody(stream, 4)).resolves.toEqual(
      new Uint8Array([1, 2, 3, 4]),
    );
  });

  it("reuses an aligned single chunk instead of copying the whole body", async () => {
    const chunk = new Uint8Array([1, 2, 3, 4]);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
        controller.close();
      },
    });

    await expect(readBoundedBody(stream, 4)).resolves.toBe(chunk);
  });
});
