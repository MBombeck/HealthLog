/**
 * Server-side PDF rasterization for the document vault.
 *
 * The OAuth/subscription wire (codex) — and every other image-only-wire provider
 * — cannot receive a native PDF `document` block; only Anthropic accepts one.
 * This module renders a PDF's pages to raster JPEG images so those providers can
 * still READ a scanned/image-only PDF: each page image goes out as an ordinary
 * `input_image` part the codex client already handles, with no client-interface
 * change. Only invoked (on the auto-read path) when the toggle authorises the
 * external egress and the picked provider is NOT Anthropic (Anthropic keeps its
 * higher-fidelity native PDF block; a text-layer PDF is still read locally for
 * free before we ever rasterize).
 *
 * pdfjs is loaded LAZILY via a runtime `import()` — its module top-level
 * references the browser-only `DOMMatrix` global, so a STATIC import would make
 * the Turbopack server chunk evaluate that reference at instantiation and throw
 * `DOMMatrix is not defined`, taking down every route/worker sharing the chunk.
 * The lazy import (the exact pattern `local-extract.ts` documents) keeps pdfjs +
 * `@napi-rs/canvas` (its Node canvas backend) out of the eager chunk. Rendering
 * is pure local compute — no network, nothing written to disk.
 *
 * Bounds (denial-of-service + vision token cost): render at most the first
 * `RASTER_MAX_PAGES` pages, each capped to `RASTER_TARGET_LONG_EDGE` on its long
 * edge (never upscaled), JPEG at `RASTER_JPEG_QUALITY`. A discharge letter / lab
 * is 1-4 pages; the cap keeps a pathological 200-page PDF from draining the
 * subscription allowance in one job.
 *
 * NEVER throws: a malformed / encrypted / unrenderable PDF, a missing native
 * binary, or any render error resolves to `{ ok: false }`, and the caller falls
 * back to the local text-layer path or leaves the document un-indexed. This
 * preserves the "a bad document never aborts an upload/batch" contract.
 */
import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { annotate } from "@/lib/logging/context";

import { nativeCanvasSupported } from "./native-canvas-support";

/**
 * Whether the PDF rasterizer is available in this build. The native
 * `@napi-rs/canvas` binary is compiled in and traced into the standalone image
 * (see `next.config.ts`), so rasterization is a standing capability — every
 * vision provider can read a PDF (Anthropic natively, all others via raster).
 * The document capability DTO reads this so the UI offers a PDF read for a
 * non-Anthropic provider; a runtime render failure still degrades gracefully
 * (`prepareVisionInput` → `pdfNeedsAnthropic` → local text or un-indexed).
 */
export const RASTERIZATION_AVAILABLE = true;

/** Render at most the first N pages — the token-cost / DoS governor. */
export const RASTER_MAX_PAGES = 10;

/**
 * Longest-edge pixel cap per page. Tighter than the client upload downscale
 * ceiling because these feed a token-metered vision model; ~1600px is legible
 * for a document read without blowing up the tile count.
 */
export const RASTER_TARGET_LONG_EDGE = 1600;

/** JPEG quality (0-100). ~80 keeps text legible at a fraction of PNG's bytes. */
export const RASTER_JPEG_QUALITY = 80;

/**
 * A rendered page counts as blank when fewer than this share of its pixels
 * are dark. One short line of 16 pt text on an A4 page is ~0.1 %; a page
 * number alone sits near this floor. A page set that is blank throughout is
 * not a reading of the document, whatever the provider would make of it.
 */
export const RASTER_MIN_INK_RATIO = 0.0001;

/** One rasterized page, shaped as a vision `input_image` part. */
export interface RasterImage {
  mediaType: "image/jpeg";
  dataBase64: string;
}

/**
 * Best-effort rasterization outcome — never an exception. Refs #776: a
 * failure names its class so the caller can tell "this build cannot raster
 * at all" (`unsupported` — the native canvas binary is unusable, a capability
 * gap Anthropic's native PDF path would cover) from "this particular PDF
 * would not render" (`render-failed` — malformed / encrypted / zero pages).
 */
export type RasterResult =
  | {
      ok: true;
      images: RasterImage[];
      /**
       * Pages in the PDF. Above `images.length` when the page cap cut the
       * render short, which a caller showing the result has to say: the
       * reading covers the first pages only.
       */
      pageCount: number;
    }
  | { ok: false; reason: "unsupported" | "render-failed" };

// Minimal structural types for the slice of the pdfjs API this module uses. A
// type-only shape (erased at build) so we never eagerly evaluate the pdfjs
// module for its types; the real module is pulled at runtime via `import()`.
interface PdfViewport {
  width: number;
  height: number;
}
interface PdfCanvas {
  width: number;
  height: number;
  toBuffer(mime: "image/jpeg", quality?: number): Buffer;
}
interface PdfContext2D {
  getImageData(
    x: number,
    y: number,
    width: number,
    height: number,
  ): { data: Uint8ClampedArray };
}
interface PdfCanvasAndContext {
  canvas: PdfCanvas;
  context: PdfContext2D;
}
interface PdfCanvasFactory {
  create(width: number, height: number): PdfCanvasAndContext;
  destroy?(target: PdfCanvasAndContext): void;
}
interface PdfPage {
  getViewport(opts: { scale: number }): PdfViewport;
  render(opts: {
    canvasContext: unknown;
    viewport: PdfViewport;
    canvas: unknown;
  }): { promise: Promise<void> };
  cleanup(): void;
}
interface PdfDocument {
  numPages: number;
  canvasFactory: PdfCanvasFactory;
  getPage(pageNumber: number): Promise<PdfPage>;
}
interface PdfLoadingTask {
  promise: Promise<PdfDocument>;
  destroy(): Promise<void>;
}
interface PdfjsModule {
  getDocument(opts: PdfDocumentOptions): PdfLoadingTask;
}
interface PdfDocumentOptions {
  data: Uint8Array;
  verbosity?: number;
  isEvalSupported?: boolean;
  useSystemFonts?: boolean;
  standardFontDataUrl?: string;
  cMapUrl?: string;
  cMapPacked?: boolean;
  wasmUrl?: string;
}
interface GlobalFontsLike {
  registerFromPath(path: string, nameAlias?: string): unknown;
}

/**
 * Where pdfjs finds the data it does not carry in its JS: the standard 14
 * fonts (a PDF that names Helvetica or Times without embedding them), the
 * CMaps (CID fonts with a predefined encoding), and the wasm image decoders
 * (JPEG 2000, JBIG2). In a browser pdfjs fetches these from a URL; under Node
 * they are read from disk, and without a directory pdfjs simply draws the text
 * without glyphs.
 *
 * The runtime image carries no system fonts at all, so nothing else catches
 * that: a letter set in a non-embedded font rendered as an empty page in the
 * container while it rendered correctly on a workstation, where the operating
 * system's fonts stood in. The image-only provider then read the empty page
 * and returned a line of nothing.
 *
 * Resolved from the working directory with Node's own resolution, which is
 * what finds the hoisted `node_modules/pdfjs-dist` in the standalone image
 * and the pnpm link in a checkout. The specifier is assembled at runtime so
 * the bundler leaves the lookup alone. The ICC profile option is not set: its
 * loader needs a synchronous XMLHttpRequest that Node lacks, and pdfjs falls
 * back to each colour space's alternate.
 */
export interface PdfjsAssets {
  standardFontDataUrl: string;
  cMapUrl: string;
  wasmUrl: string;
  /** The Liberation Sans faces registered as the generic fallback families. */
  fallbackFonts: string[];
}

let cachedAssets: PdfjsAssets | null | undefined;

export function resolvePdfjsAssets(): PdfjsAssets | null {
  if (cachedAssets !== undefined) return cachedAssets;
  cachedAssets = null;
  try {
    const anchor = createRequire(join(process.cwd(), "package.json"));
    const root = dirname(
      anchor.resolve(["pdfjs-dist", "package.json"].join("/")),
    );
    const fonts = join(root, "standard_fonts");
    const assets: PdfjsAssets = {
      standardFontDataUrl: `${fonts}/`,
      cMapUrl: `${join(root, "cmaps")}/`,
      wasmUrl: `${join(root, "wasm")}/`,
      fallbackFonts: [
        "LiberationSans-Regular.ttf",
        "LiberationSans-Bold.ttf",
        "LiberationSans-Italic.ttf",
        "LiberationSans-BoldItalic.ttf",
      ].map((file) => join(fonts, file)),
    };
    if (
      existsSync(join(fonts, "FoxitSerif.pfb")) &&
      existsSync(join(root, "cmaps", "UniJIS-UTF16-H.bcmap")) &&
      existsSync(join(root, "wasm", "openjpeg.wasm")) &&
      assets.fallbackFonts.every((file) => existsSync(file))
    ) {
      cachedAssets = assets;
    }
  } catch {
    // Unresolvable: render without the data, as before, and say so below.
  }
  return cachedAssets;
}

let fallbackFamiliesRegistered = false;

/**
 * Give the canvas a face for the generic families pdfjs falls back to.
 *
 * When pdfjs cannot use a font program (a damaged or unsupported embedded
 * font, or a non-embedded face outside the standard 14) it draws the text
 * with the canvas' own `fillText` under the PDF's font name and a generic
 * family. With no system fonts in the image that text vanished. Registering
 * Liberation Sans, which pdfjs ships, under `sans-serif`, `serif` and
 * `monospace` makes it legible instead. Once per process.
 */
async function registerFallbackFamilies(assets: PdfjsAssets): Promise<void> {
  if (fallbackFamiliesRegistered) return;
  fallbackFamiliesRegistered = true;
  const { GlobalFonts } = (await import("@napi-rs/canvas")) as unknown as {
    GlobalFonts: GlobalFontsLike;
  };
  for (const family of ["sans-serif", "serif", "monospace"]) {
    for (const file of assets.fallbackFonts) {
      GlobalFonts.registerFromPath(file, family);
    }
  }
}

/** Share of dark pixels on a rendered page (luminance below half). */
function inkRatio(context: PdfContext2D, width: number, height: number) {
  const { data } = context.getImageData(0, 0, width, height);
  let dark = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i]! + data[i + 1]! + data[i + 2]! < 384) dark++;
  }
  const pixels = data.length / 4;
  return pixels > 0 ? dark / pixels : 0;
}

/** Test hook: the asset lookup and the font registration are per process. */
export function __resetPdfjsAssetsForTests(): void {
  cachedAssets = undefined;
  fallbackFamiliesRegistered = false;
}

/**
 * Render the first `RASTER_MAX_PAGES` pages of a PDF to bounded JPEG images
 * (or fewer when `maxPages` is passed — the thumbnail path renders page 1
 * only). Returns `{ ok: false }` on any failure (malformed PDF, render throw,
 * missing binary, or zero renderable pages) — the caller degrades to local
 * text or un-indexed. Never throws.
 */
export async function rasterizePdf(
  buffer: Buffer,
  maxPages: number = RASTER_MAX_PAGES,
): Promise<RasterResult> {
  let doc: PdfDocument | null = null;
  let task: PdfLoadingTask | null = null;
  // CPU-feature gate: pdfjs renders through @napi-rs/canvas (Skia), whose x64
  // build uses AVX2 — an unsupported CPU dies with an uncatchable SIGILL on
  // the first render. Degrade to the existing no-raster path instead (scanned
  // PDFs stay unreadable for image-only providers; everything else works).
  if (!nativeCanvasSupported()) {
    annotate({
      action: { name: "documents.rasterize.failed" },
      meta: { reason: "native_canvas_unsupported" },
    });
    return { ok: false, reason: "unsupported" };
  }
  try {
    // Lazy import: keeps pdfjs (DOMMatrix) + @napi-rs/canvas out of the eager
    // server chunk. Resolved at first rasterization, then module-cached.
    const pdfjs =
      (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as PdfjsModule;

    const assets = resolvePdfjsAssets();
    if (assets) {
      await registerFallbackFamilies(assets);
    } else {
      annotate({
        action: { name: "documents.rasterize.assetsMissing" },
        meta: { reason: "pdfjs_assets_unresolved" },
      });
    }

    task = pdfjs.getDocument({
      data: new Uint8Array(buffer),
      verbosity: 0, // VerbosityLevel.ERRORS — no console spam on odd PDFs.
      isEvalSupported: false, // never eval font programs (defence in depth).
      // There are no system fonts to use: substitutes come from pdfjs' own
      // standard font data and the fallback families registered above.
      useSystemFonts: false,
      ...(assets
        ? {
            standardFontDataUrl: assets.standardFontDataUrl,
            cMapUrl: assets.cMapUrl,
            cMapPacked: true,
            wasmUrl: assets.wasmUrl,
          }
        : {}),
    });
    doc = await task.promise;

    // Never exceed the standing DoS ceiling, even if a caller asks for more.
    const cap = Math.min(Math.max(1, maxPages), RASTER_MAX_PAGES);
    const pageCount = Math.min(doc.numPages, cap);
    const images: RasterImage[] = [];
    let blankPages = 0;

    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      try {
        const base = page.getViewport({ scale: 1 });
        const longEdge = Math.max(base.width, base.height);
        // Cap the long edge, never upscale (scale ≤ 1).
        const scale =
          longEdge > 0 ? Math.min(1, RASTER_TARGET_LONG_EDGE / longEdge) : 1;
        const viewport = page.getViewport({ scale });

        const factory = doc.canvasFactory;
        const cc = factory.create(
          Math.ceil(viewport.width),
          Math.ceil(viewport.height),
        );
        await page.render({
          canvasContext: cc.context,
          viewport,
          canvas: cc.canvas,
        }).promise;
        if (
          inkRatio(cc.context, cc.canvas.width, cc.canvas.height) <
          RASTER_MIN_INK_RATIO
        ) {
          blankPages++;
        }
        const jpeg = cc.canvas.toBuffer("image/jpeg", RASTER_JPEG_QUALITY);
        images.push({
          mediaType: "image/jpeg",
          dataBase64: jpeg.toString("base64"),
        });
        factory.destroy?.(cc);
      } finally {
        page.cleanup();
      }
    }

    if (images.length === 0) {
      // Refs #776 — the zero-pages shape must be as loud as a throw: a
      // document that "rendered" nothing is a failed rasterization, and the
      // wide event is what lets an operator see WHY a scan stayed unread.
      annotate({
        action: { name: "documents.rasterize.failed" },
        meta: { reason: "zero_pages", pageCount: doc.numPages },
      });
      return { ok: false, reason: "render-failed" };
    }
    if (blankPages === images.length) {
      // Every rendered page came out empty. Sending those to a vision model
      // buys a transcript of nothing that would be indexed as a success; say
      // the render failed instead, so the read reports `raster-failed`.
      annotate({
        action: { name: "documents.rasterize.failed" },
        meta: { reason: "blank_pages", pages: images.length },
      });
      return { ok: false, reason: "render-failed" };
    }
    annotate({
      action: { name: "documents.rasterize.ok" },
      meta: { pages: images.length, cappedFrom: doc.numPages, blankPages },
    });
    return { ok: true, images, pageCount: doc.numPages };
  } catch (err) {
    annotate({
      action: { name: "documents.rasterize.failed" },
      meta: {
        reason: err instanceof Error ? err.name : "unknown",
        // The message pins WHY a render failed (bundled-module mismatch, an
        // encrypted/odd PDF, a font issue) — the name alone is opaque. Bounded
        // so a pathological message can't bloat the wide event.
        message: err instanceof Error ? err.message.slice(0, 300) : String(err),
      },
    });
    return { ok: false, reason: "render-failed" };
  } finally {
    if (task) {
      try {
        await task.destroy();
      } catch {
        // Best-effort teardown; a destroy failure must not mask the result.
      }
    }
  }
}
