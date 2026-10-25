import { Buffer } from "node:buffer";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeflate } from "node:zlib";

import { describe, expect, it, vi } from "vitest";

const { annotate } = vi.hoisted(() => ({ annotate: vi.fn() }));
vi.mock("@/lib/logging/context", () => ({ annotate }));

import { gif } from "../../__tests__/gif-fixture";
import {
  MAX_QUEUED_PER_OWNER,
  READER_WAIT_MS,
  runOnce,
  runPdfChild,
  withPdfWork,
  type PdfChildRequest,
  type PdfChildResult,
} from "../pdf-isolation";
import { readPdfText } from "../pdfjs";
import { rasterizePdf } from "../rasterize-pdf";
import { generateThumbnail } from "../thumbnail";

/**
 * A PDF decides how much memory and time reading it costs. A 400 KB upload
 * declaring a 20000 x 20000 image made pdf.js allocate about 7 GB inside the
 * web process; the container was killed for every user and the thumbnail job
 * ran the same document again after the restart. pdf.js' `maxImageSize`
 * stops that shape, but an image whose soft mask declares the same size still
 * allocates it, so every read and render runs in a child process with a
 * memory ceiling and a time limit.
 *
 * The documents below are built here: a page with one Flate-compressed image
 * of zeros, which compresses about a thousand to one.
 *
 * Mutation checks:
 *   - drop `maxImageSize` from `openPdfDocument` → "skips an image past the
 *     pixel limit" crosses its 250 MB budget and answers `limit`;
 *   - stop sampling the child's memory in `runPdfChild` → the soft-mask case
 *     takes gigabytes and comes back `ok`;
 *   - run `rasterizePdf` in this process again → the soft-mask case grows
 *     this process by gigabytes.
 */

async function deflateZeros(width: number, height: number): Promise<Buffer> {
  const deflate = createDeflate({ level: 9 });
  const chunks: Buffer[] = [];
  deflate.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<void>((resolve, reject) => {
    deflate.on("end", resolve);
    deflate.on("error", reject);
  });
  const row = Buffer.alloc(width);
  for (let y = 0; y < height; y++) {
    if (!deflate.write(row)) {
      await new Promise((resolve) => deflate.once("drain", resolve));
    }
  }
  deflate.end();
  await done;
  return Buffer.concat(chunks);
}

function assemble(objects: Buffer[]): Buffer {
  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n", "latin1")];
  let length = parts[0]!.length;
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(length);
    const part = Buffer.concat([
      Buffer.from(`${i + 1} 0 obj\n`, "latin1"),
      body,
      Buffer.from("\nendobj\n", "latin1"),
    ]);
    parts.push(part);
    length += part.length;
  });
  let tail = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    tail += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  tail += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`;
  parts.push(Buffer.from(tail, "latin1"));
  return Buffer.concat(parts);
}

function stream(dict: string, data: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`<< ${dict} /Length ${data.length} >>\nstream\n`, "latin1"),
    data,
    Buffer.from("\nendstream", "latin1"),
  ]);
}

/**
 * One page drawing one image. With `softMask`, the image is 2 x 2 and its
 * soft mask carries the declared size instead.
 */
async function imagePdf(size: number, softMask = false): Promise<Buffer> {
  const zeros = await deflateZeros(size, size);
  const big = `/Type /XObject /Subtype /Image /Width ${size} /Height ${size} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode`;
  const content = Buffer.from("q 612 0 0 792 0 0 cm /Im1 Do Q", "latin1");
  const objects = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>", "latin1"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "latin1"),
    Buffer.from(
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>",
      "latin1",
    ),
    stream("", content),
    softMask
      ? stream(
          "/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8 /SMask 6 0 R",
          Buffer.alloc(4),
        )
      : stream(big, zeros),
  ];
  if (softMask) objects.push(stream(big, zeros));
  return assemble(objects);
}

const RENDER_ONE_PAGE = {
  maxPages: 1,
  targetLongEdge: 1600,
  jpegQuality: 80,
  minInkRatio: 0.0001,
};

const fixture = readFileSync(
  join(process.cwd(), "tests", "fixtures", "pdf", "fallback-fonts.pdf"),
);

describe("PDF reading runs in a bounded child process", () => {
  it("renders and reads an ordinary document", async () => {
    const raster = await rasterizePdf(fixture, 1, { withText: true });
    expect(raster.ok).toBe(true);
    if (!raster.ok) return;
    expect(raster.images).toHaveLength(1);
    expect(raster.texts?.[0]?.length).toBeGreaterThan(0);
    await expect(readPdfText(fixture)).resolves.toMatch(/\w{4}/);
  });

  it("skips an image past the pixel limit and stays inside a small budget", async () => {
    // 100 million pixels: about 1.7 GB to decode when nothing stops it.
    const bomb = await imagePdf(10_000);
    expect(bomb.length).toBeLessThan(200_000);

    const result = await runPdfChild(
      { op: "render", data: bomb, options: RENDER_ONE_PAGE },
      { timeoutMs: 30_000, memoryMb: 250 },
    );
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    // The image was left out, so the page is blank.
    expect(result.value.pages[0]!.blank).toBe(true);
  });

  it("ends a document that outgrows the ceiling, and the server keeps running", async () => {
    const bomb = await imagePdf(20_000, true);
    const before = process.memoryUsage().rss;

    const result = await runPdfChild(
      { op: "render", data: bomb, options: RENDER_ONE_PAGE },
      { timeoutMs: 60_000, memoryMb: 300 },
    );
    expect(result).toEqual({ ok: false, reason: "limit", limit: "memory" });
    // Nothing of the decode landed in this process.
    expect(process.memoryUsage().rss - before).toBeLessThan(200 * 1024 ** 2);
  }, 90_000);

  it("ends a read that runs past its time limit", async () => {
    const result = await runPdfChild(
      { op: "text", data: fixture, maxPages: 1 },
      { timeoutMs: 1 },
    );
    expect(result).toEqual({ ok: false, reason: "limit", limit: "time" });
  });

  it("reports a document that crossed a bound as final, not as a render failure", async () => {
    const bomb = await imagePdf(20_000, true);
    // The default ceiling: what the server runs with.
    const thumb = await generateThumbnail(bomb, "application/pdf");
    expect(thumb).toEqual({ ok: false, reason: "resource-limit" });
    expect(annotate).toHaveBeenCalledWith({
      action: { name: "documents.rasterize.failed" },
      meta: { reason: "resource_limit", limit: "memory" },
    });
  }, 90_000);

  it("names what pdf.js threw on a file that is not a PDF", async () => {
    const result = await runPdfChild(
      { op: "text", data: Buffer.from("not a pdf"), maxPages: 1 },
      { timeoutMs: 30_000 },
    );
    expect(result).toMatchObject({ ok: false, reason: "error" });
  });
});

describe("an image upload is decoded in the bounded child", () => {
  it("ends the child, not the server, when a decoder allocates past the ceiling", async () => {
    // The header walk refuses this file; here it goes to the decoder
    // directly, as a decoder surprise the walk did not foresee would.
    const bomb = gif({ width: 10, height: 10 }, [
      { width: 20_000, height: 20_000 },
    ]);
    const before = process.memoryUsage().rss;
    const result = await runPdfChild(
      {
        op: "image-thumbnail",
        data: bomb,
        options: { longEdge: 320, quality: 70, maxPixels: 1e12 },
      },
      { timeoutMs: 60_000, memoryMb: 300 },
    );
    expect(result).toEqual({ ok: false, reason: "limit", limit: "memory" });
    expect(process.memoryUsage().rss - before).toBeLessThan(200 * 1024 ** 2);
  }, 90_000);
});

describe("a child that ends without an answer", () => {
  const dir = mkdtempSync(join(tmpdir(), "reader-child-"));
  const script = (name: string, body: string) => {
    const path = join(dir, name);
    writeFileSync(path, body);
    return path;
  };
  const request = { op: "text", data: Buffer.from("x"), maxPages: 1 } as const;

  it("is not a final verdict when nothing this module measured ended it", async () => {
    // A kill from outside: the kernel's out-of-memory killer acting for the
    // whole container looks like this to the parent.
    const killed = script(
      "killed-child",
      'process.kill(process.pid, "SIGKILL");\n',
    );
    await expect(
      runOnce(killed, request, { timeoutMs: 10_000 }),
    ).resolves.toEqual({ ok: false, reason: "interrupted" });
  });

  it("is the document's doing when V8 reached the heap cap the child was given", async () => {
    const heap = script(
      "heap-child",
      'process.stderr.write("FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\\n", () => process.exit(134));\n',
    );
    await expect(
      runOnce(heap, request, { timeoutMs: 10_000 }),
    ).resolves.toEqual({ ok: false, reason: "limit", limit: "memory" });
  });

  it("is run once more, and answered interrupted when it ends that way again", async () => {
    const interrupted = vi.fn(
      async (): Promise<PdfChildResult<PdfChildRequest>> => ({
        ok: false,
        reason: "interrupted",
      }),
    );
    await expect(
      runPdfChild(request, { timeoutMs: 1_000, run: interrupted }),
    ).resolves.toEqual({ ok: false, reason: "interrupted" });
    expect(interrupted).toHaveBeenCalledTimes(2);

    const recovers = vi
      .fn<() => Promise<PdfChildResult<PdfChildRequest>>>()
      .mockResolvedValueOnce({ ok: false, reason: "interrupted" })
      .mockResolvedValueOnce({ ok: true, value: "text" });
    await expect(
      runPdfChild(request, { timeoutMs: 1_000, run: recovers }),
    ).resolves.toEqual({ ok: true, value: "text" });
    expect(recovers).toHaveBeenCalledTimes(2);
  });
});

describe("the reader's queue", () => {
  it("answers one account's work past its waiting cap busy, at once", async () => {
    const request = {
      op: "text",
      data: Buffer.from("x"),
      maxPages: 1,
    } as const;
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => (open = resolve));
    const run = vi.fn(async (): Promise<PdfChildResult<PdfChildRequest>> => {
      await gate;
      return { ok: true, value: "text" };
    });
    const asA = () =>
      withPdfWork({ owner: "account-a", lane: "interactive" }, () =>
        runPdfChild(request, { timeoutMs: 1_000, run }),
      );

    const running = asA();
    const waiting = Array.from({ length: MAX_QUEUED_PER_OWNER }, asA);
    await expect(asA()).resolves.toMatchObject({ ok: false, reason: "busy" });

    open();
    await expect(running).resolves.toMatchObject({ ok: true });
    for (const item of waiting) {
      await expect(item).resolves.toMatchObject({ ok: true });
    }
  });
});

describe("the caller's clock while it waits for the reader", () => {
  const request = { op: "text", data: Buffer.from("x"), maxPages: 1 } as const;

  it("moves by the wait plus the read's allowance when the slot is granted, then gives back what the read did not use", async () => {
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => (open = resolve));
    const holder = vi.fn(async (): Promise<PdfChildResult<PdfChildRequest>> => {
      await gate;
      return { ok: true, value: "first" };
    });
    const quick = vi.fn(async (): Promise<PdfChildResult<PdfChildRequest>> => ({
      ok: true,
      value: "second",
    }));
    const moves: number[] = [];
    const first = withPdfWork({ owner: "a", lane: "interactive" }, () =>
      runPdfChild(request, { timeoutMs: 1_000, run: holder }),
    );
    const second = withPdfWork(
      {
        owner: "b",
        lane: "interactive",
        extendDeadline: async (ms) => {
          moves.push(ms);
        },
      },
      () => runPdfChild(request, { timeoutMs: 1_000, run: quick }),
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    open();
    await expect(first).resolves.toMatchObject({ ok: true });
    await expect(second).resolves.toMatchObject({ ok: true, value: "second" });

    // Granted after about 150 ms of waiting, with two attempts' allowance.
    expect(moves).toHaveLength(2);
    expect(moves[0]!).toBeGreaterThanOrEqual(2_000 + 140);
    expect(moves[0]!).toBeLessThan(2_000 + 1_000);
    // The quick read gives back nearly all of its allowance.
    expect(moves[1]!).toBeLessThan(0);
    expect(moves[1]!).toBeGreaterThan(-2_000 - 1);
    // Net: the wait and the read's own time, nothing more.
    expect(moves[0]! + moves[1]!).toBeGreaterThanOrEqual(140);
    expect(moves[0]! + moves[1]!).toBeLessThan(1_000);
  });

  it("reads on when moving the clock fails", async () => {
    const run = vi.fn(async (): Promise<PdfChildResult<PdfChildRequest>> => ({
      ok: true,
      value: "text",
    }));
    await expect(
      withPdfWork(
        {
          owner: "c",
          lane: "interactive",
          extendDeadline: async () => {
            throw new Error("database gone");
          },
        },
        () => runPdfChild(request, { timeoutMs: 1_000, run }),
      ),
    ).resolves.toEqual({ ok: true, value: "text" });
  });

  it("waits no longer for the reader than a run's margin can absorb before the slot moves its deadline", async () => {
    // The deadline moves when the slot is granted; until then the run's
    // armed margin is all that stands between a waiting read and the
    // reaper.
    const { AI_RUN_MARGIN_MS } = await import("../ai-runs/types");
    expect(READER_WAIT_MS.interactive).toBeLessThanOrEqual(AI_RUN_MARGIN_MS);
  });
});
