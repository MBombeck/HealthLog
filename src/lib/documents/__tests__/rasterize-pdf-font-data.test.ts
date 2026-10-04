import { Buffer } from "node:buffer";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { createCanvas, loadImage } from "@napi-rs/canvas";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GitHub #1124 — PDFs from older OCRmyPDF archives got no thumbnail and an
 * image-only vision read of them came back nearly empty.
 *
 * The runtime image has no system fonts. pdfjs was opened without its own
 * font data and told to lean on system fonts, so any text it could not draw
 * from an embedded program (a non-embedded standard font, or an embedded
 * program it cannot parse) came out as nothing, and the page that reached
 * the provider was the background alone. A workstation hides this because
 * its own fonts stand in, so the rendering assertions below are regression
 * guards here and the container is where they were proven red; the option
 * and registration assertions are red on any host.
 *
 * Fixtures (`tests/fixtures/pdf/`, synthetic text only):
 *   - `ocrmypdf11-two-images-type1c.pdf` — the reporter's shape: PDF 1.7,
 *     pikepdf producer, one 630.5 x 861.6 pt page with a 150 ppi RGB JPEG and
 *     a 75 ppi RGB Flate image, Type 1C Helvetica and Palatino-Roman, and an
 *     invisible OCR text layer.
 *   - `fallback-fonts.pdf` — a letter in non-embedded Helvetica and in a
 *     Type 1C Palatino-Roman whose program pdfjs cannot parse.
 *   - `invisible-text-only.pdf` — text in render mode 3 and nothing else, so
 *     every page renders blank.
 */

const { annotate, registerFromPath } = vi.hoisted(() => ({
  annotate: vi.fn(),
  registerFromPath: vi.fn(),
}));
vi.mock("@/lib/logging/context", () => ({ annotate }));

const getDocumentOptions: Record<string, unknown>[] = [];
vi.mock("pdfjs-dist/legacy/build/pdf.mjs", async (importActual) => {
  const actual =
    await importActual<typeof import("pdfjs-dist/legacy/build/pdf.mjs")>();
  return {
    ...actual,
    getDocument: (opts: Record<string, unknown>) => {
      getDocumentOptions.push(opts);
      return actual.getDocument(opts as never);
    },
  };
});
vi.mock("@napi-rs/canvas", async (importActual) => {
  const actual = await importActual<typeof import("@napi-rs/canvas")>();
  return {
    ...actual,
    GlobalFonts: {
      ...actual.GlobalFonts,
      registerFromPath: (path: string, alias?: string) => {
        registerFromPath(path, alias);
        return actual.GlobalFonts.registerFromPath(path, alias);
      },
    },
  };
});

import * as raster from "../rasterize-pdf";
import { generateThumbnail } from "../thumbnail";

const FIXTURES = join(process.cwd(), "tests", "fixtures", "pdf");
const fixture = (name: string) => readFileSync(join(FIXTURES, name));

/** Share of dark pixels in a JPEG, measured the way the rasterizer does. */
async function inkOf(base64: string): Promise<number> {
  const image = await loadImage(Buffer.from(base64, "base64"));
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0);
  const { data } = ctx.getImageData(0, 0, image.width, image.height);
  let dark = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i]! + data[i + 1]! + data[i + 2]! < 384) dark++;
  }
  return dark / (data.length / 4);
}

beforeEach(() => {
  annotate.mockClear();
  registerFromPath.mockClear();
  getDocumentOptions.length = 0;
  raster.__resetPdfjsAssetsForTests();
});

describe("rasterizePdf font and decoder data (#1124)", () => {
  it("gives pdfjs its font, CMap and wasm directories and no system fonts", async () => {
    const result = await raster.rasterizePdf(fixture("fallback-fonts.pdf"), 1);
    expect(result.ok).toBe(true);
    const opts = getDocumentOptions.at(-1)!;
    expect(opts.useSystemFonts).toBe(false);
    for (const [key, probe] of [
      ["standardFontDataUrl", "FoxitSerif.pfb"],
      ["standardFontDataUrl", "LiberationSans-Regular.ttf"],
      ["cMapUrl", "UniJIS-UTF16-H.bcmap"],
      ["wasmUrl", "openjpeg.wasm"],
    ] as const) {
      expect(typeof opts[key], key).toBe("string");
      expect(existsSync(`${opts[key] as string}${probe}`), probe).toBe(true);
    }
    expect(opts.cMapPacked).toBe(true);
  });

  it("registers a fallback face for every generic family pdfjs falls back to", async () => {
    await raster.rasterizePdf(fixture("fallback-fonts.pdf"), 1);
    const families = new Set(registerFromPath.mock.calls.map((c) => c[1]));
    expect(families).toEqual(new Set(["sans-serif", "serif", "monospace"]));
    for (const [path] of registerFromPath.mock.calls) {
      expect(existsSync(path as string)).toBe(true);
    }
  });

  it("renders the OCRmyPDF page with its scan and its text", async () => {
    const result = await raster.rasterizePdf(
      fixture("ocrmypdf11-two-images-type1c.pdf"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.images).toHaveLength(1);
    expect(await inkOf(result.images[0]!.dataBase64)).toBeGreaterThan(0.005);
  });

  it("renders a letter whose fonts pdfjs has to substitute", async () => {
    const result = await raster.rasterizePdf(fixture("fallback-fonts.pdf"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await inkOf(result.images[0]!.dataBase64)).toBeGreaterThan(0.001);
  });

  it("reports a document whose every page renders blank as render-failed", async () => {
    const result = await raster.rasterizePdf(
      fixture("invisible-text-only.pdf"),
    );
    expect(result).toEqual({ ok: false, reason: "render-failed" });
    expect(annotate).toHaveBeenCalledWith({
      action: { name: "documents.rasterize.failed" },
      meta: { reason: "blank_pages", pages: 1 },
    });
  });
});

describe("generateThumbnail on the OCRmyPDF shape (#1124)", () => {
  it("produces a preview of the first page", async () => {
    const result = await generateThumbnail(
      fixture("ocrmypdf11-two-images-type1c.pdf"),
      "application/pdf",
    );
    expect(result.ok).toBe(true);
  });
});
