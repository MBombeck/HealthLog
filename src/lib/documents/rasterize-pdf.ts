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
 * pdf.js is opened through `./pdfjs`, the one loader the local text read uses
 * too (two copies in one process break each other, #1277). It loads pdf.js
 * and `@napi-rs/canvas` (its Node canvas backend) lazily, keeping both out of
 * the eager server chunk. Rendering is pure local compute — no network,
 * nothing written to disk.
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

import { annotate } from "@/lib/logging/context";

import { nativeCanvasSupported } from "./native-canvas-support";
import {
  openPdfDocument,
  resolvePdfjsAssets,
  type PdfContext2D,
  type PdfDocument,
  type PdfjsAssets,
  type PdfLoadingTask,
  type PdfPage,
} from "./pdfjs";

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
 * The ceiling a caller may raise the page count to. The lab scan reads a
 * multi-panel report page by page and asks for more than the document read's
 * default; nothing may ask for more than this.
 */
export const RASTER_HARD_MAX_PAGES = 20;

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
      /**
       * Only with `withText`: each rendered page's text layer, in order and
       * aligned with `images`. Empty for a page that has none (a scan) or
       * whose text could not be read.
       */
      texts?: string[];
    }
  | { ok: false; reason: "unsupported" | "render-failed" };

interface GlobalFontsLike {
  registerFromPath(path: string, nameAlias?: string): unknown;
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

/** Test hook: the font registration is per process. */
export function __resetFallbackFamiliesForTests(): void {
  fallbackFamiliesRegistered = false;
}

/**
 * The most text kept from one page's text layer. Collection stops here while
 * the items are read, so a PDF whose content streams inflate to megabytes of
 * text cannot hold them in memory for the length of a run. A dense lab page
 * is well below it.
 */
export const RASTER_PAGE_TEXT_MAX = 12_000;

/** Marks where a text layer was cut. */
export const TEXT_LAYER_CUT_MARK = "[text layer cut here]";

/**
 * The head of `text` that fits `room` characters: cut at the last space before
 * the limit so no number is cut in half, or hard at the limit when the text
 * has no space to cut at.
 */
function headThatFits(text: string, room: number): string {
  if (text.length <= room) return text;
  const head = text.slice(0, room);
  const space = head.lastIndexOf(" ");
  return space > 0 ? head.slice(0, space) : head;
}

/**
 * A page's text layer, line by line: what the PDF states as characters.
 * Empty for a page without one or on any failure. Past
 * `RASTER_PAGE_TEXT_MAX` it is cut (at a line, else a space, else hard) and
 * marked.
 */
export async function pageText(
  page: Pick<PdfPage, "getTextContent">,
): Promise<string> {
  const max = RASTER_PAGE_TEXT_MAX;
  try {
    const { items } = await page.getTextContent();
    const lines: string[] = [];
    let length = 0;
    let line = "";
    // Cut at the last whole line; only a page whose first line alone runs
    // past the cap keeps part of that line, cut at a space or hard.
    const cut = (): string => {
      if (lines.length === 0) {
        const room = max - TEXT_LAYER_CUT_MARK.length - 1;
        const head = headThatFits(line.replace(/\s+/g, " ").trim(), room);
        if (head.trim()) lines.push(head.trim());
      }
      lines.push(TEXT_LAYER_CUT_MARK);
      return lines.join("\n");
    };
    /** Adds the line in hand; false when it does not fit. */
    const flush = (): boolean => {
      const clean = line.replace(/\s+/g, " ").trim();
      if (!clean) {
        line = "";
        return true;
      }
      if (length + clean.length + 1 > max - TEXT_LAYER_CUT_MARK.length - 1) {
        return false;
      }
      lines.push(clean);
      length += clean.length + 1;
      line = "";
      return true;
    };
    for (const item of items) {
      line += `${item.str ?? ""} `;
      // A line that runs on without a break is judged at the cap, so one
      // endless line cannot grow past it either.
      if ((item.hasEOL || line.length > max) && !flush()) return cut();
    }
    if (!flush()) return cut();
    return lines.join("\n");
  } catch {
    return "";
  }
}

/**
 * Render the first `RASTER_MAX_PAGES` pages of a PDF to bounded JPEG images
 * (or another count when `maxPages` is passed — the thumbnail path renders
 * page 1 only, the lab scan up to `RASTER_HARD_MAX_PAGES`). Returns `{ ok: false }` on any failure (malformed PDF, render throw,
 * missing binary, or zero renderable pages) — the caller degrades to local
 * text or un-indexed. Never throws.
 */
export async function rasterizePdf(
  buffer: Buffer,
  maxPages: number = RASTER_MAX_PAGES,
  opts: { withText?: boolean } = {},
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
    const assets = resolvePdfjsAssets();
    if (assets) {
      await registerFallbackFamilies(assets);
    } else {
      annotate({
        action: { name: "documents.rasterize.assetsMissing" },
        meta: { reason: "pdfjs_assets_unresolved" },
      });
    }

    task = await openPdfDocument(buffer);
    doc = await task.promise;

    // Never exceed the standing DoS ceiling, even if a caller asks for more.
    const cap = Math.min(Math.max(1, maxPages), RASTER_HARD_MAX_PAGES);
    const pageCount = Math.min(doc.numPages, cap);
    const images: RasterImage[] = [];
    const texts: string[] = [];
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
        if (opts.withText) texts.push(await pageText(page));
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
    return {
      ok: true,
      images,
      pageCount: doc.numPages,
      ...(opts.withText ? { texts } : {}),
    };
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
