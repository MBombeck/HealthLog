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
 * The rendering itself runs in a child process under a memory ceiling and a
 * time limit (`./pdf-isolation.ts`), through the one pdf.js loader
 * (`./pdf-engine.mjs`) the local text read uses too. A document built to
 * exhaust memory or time ends that child and answers `resource-limit`; the
 * server keeps running. Rendering is pure local compute — no network,
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
import { runPdfChild } from "./pdf-isolation";

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
 * would not render" (`render-failed` — malformed / encrypted / zero pages),
 * and both from "this PDF crossed the renderer's memory or time bound"
 * (`resource-limit`), which the same bytes will cross again.
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
  | {
      ok: false;
      reason:
        | "unsupported"
        | "render-failed"
        | "resource-limit"
        /**
         * Not an answer about this document: the reader was busy past the
         * wait this work may spend, or its process ended for no reason it
         * measured. The caller tries again later.
         */
        | "busy"
        | "interrupted";
    };

export {
  pageText,
  RASTER_PAGE_TEXT_MAX,
  TEXT_LAYER_CUT_MARK,
} from "./pdf-engine.mjs";

/**
 * How long a render may take: a base for opening the document plus a share
 * per page. A page that takes longer than this is not a page a reader waits
 * on, and the time limit is what ends a document built to keep the renderer
 * busy.
 */
export const RASTER_TIMEOUT_BASE_MS = 15_000;
export const RASTER_TIMEOUT_PER_PAGE_MS = 5_000;

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
  // CPU-feature gate: pdfjs renders through @napi-rs/canvas (Skia), whose x64
  // build uses AVX2 — an unsupported CPU dies with SIGILL on the first
  // render. Degrade to the existing no-raster path instead (scanned PDFs stay
  // unreadable for image-only providers; everything else works).
  if (!nativeCanvasSupported()) {
    annotate({
      action: { name: "documents.rasterize.failed" },
      meta: { reason: "native_canvas_unsupported" },
    });
    return { ok: false, reason: "unsupported" };
  }

  // Never exceed the standing DoS ceiling, even if a caller asks for more.
  const cap = Math.min(Math.max(1, maxPages), RASTER_HARD_MAX_PAGES);
  const result = await runPdfChild(
    {
      op: "render",
      data: buffer,
      options: {
        maxPages: cap,
        targetLongEdge: RASTER_TARGET_LONG_EDGE,
        jpegQuality: RASTER_JPEG_QUALITY,
        minInkRatio: RASTER_MIN_INK_RATIO,
        withText: opts.withText === true,
      },
    },
    { timeoutMs: RASTER_TIMEOUT_BASE_MS + cap * RASTER_TIMEOUT_PER_PAGE_MS },
  );

  if (!result.ok) {
    if (result.reason === "busy" || result.reason === "interrupted") {
      annotate({
        action: { name: "documents.rasterize.deferred" },
        meta: { reason: result.reason },
      });
      return { ok: false, reason: result.reason };
    }
    if (result.reason === "limit") {
      annotate({
        action: { name: "documents.rasterize.failed" },
        meta: { reason: "resource_limit", limit: result.limit },
      });
      return { ok: false, reason: "resource-limit" };
    }
    annotate({
      action: { name: "documents.rasterize.failed" },
      meta: {
        reason: result.name,
        // The message pins WHY a render failed (an encrypted or odd PDF, a
        // font issue) — the name alone is opaque. Bounded so a pathological
        // message can't bloat the wide event.
        message: result.message.slice(0, 300),
      },
    });
    return { ok: false, reason: "render-failed" };
  }

  const doc = result.value;
  if (doc.assetsMissing) {
    annotate({
      action: { name: "documents.rasterize.assetsMissing" },
      meta: { reason: "pdfjs_assets_unresolved" },
    });
  }
  if (doc.pages.length === 0) {
    // Refs #776 — the zero-pages shape must be as loud as a throw: a
    // document that "rendered" nothing is a failed rasterization, and the
    // wide event is what lets an operator see WHY a scan stayed unread.
    annotate({
      action: { name: "documents.rasterize.failed" },
      meta: { reason: "zero_pages", pageCount: doc.pageCount },
    });
    return { ok: false, reason: "render-failed" };
  }
  const blankPages = doc.pages.filter((page) => page.blank).length;
  if (blankPages === doc.pages.length) {
    // Every rendered page came out empty. Sending those to a vision model
    // buys a transcript of nothing that would be indexed as a success; say
    // the render failed instead, so the read reports `raster-failed`.
    annotate({
      action: { name: "documents.rasterize.failed" },
      meta: { reason: "blank_pages", pages: doc.pages.length },
    });
    return { ok: false, reason: "render-failed" };
  }
  annotate({
    action: { name: "documents.rasterize.ok" },
    meta: { pages: doc.pages.length, cappedFrom: doc.pageCount, blankPages },
  });
  const images: RasterImage[] = doc.pages.map((page) => ({
    mediaType: "image/jpeg",
    dataBase64: page.jpeg.toString("base64"),
  }));
  return {
    ok: true,
    images,
    pageCount: doc.pageCount,
    ...(opts.withText
      ? { texts: doc.pages.map((page) => page.text ?? "") }
      : {}),
  };
}
