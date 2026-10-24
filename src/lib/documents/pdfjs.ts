/**
 * The one pdf.js this server runs, and the one way it is opened.
 *
 * Under Node, pdf.js does not start a worker thread: it loads its worker code
 * into the same process and keeps it on `globalThis.pdfjsWorker`. Whichever
 * copy of pdf.js opens a document first owns that global until the process
 * exits, and any other copy then refuses every document with "The API version
 * … does not match the Worker version …". The server used to load two copies,
 * one for the local text read and one for rasterizing, so whichever ran first
 * broke the other until a restart (#1277). Both paths now open documents
 * here, through the app's own `pdfjs-dist`, with the same options;
 * `src/__tests__/single-pdfjs-guard.test.ts` keeps a second copy out.
 *
 * pdf.js is loaded lazily with a runtime `import()`: its module top level
 * reads the browser-only `DOMMatrix` global, so a static import would make the
 * server chunk evaluate it at instantiation and throw `DOMMatrix is not
 * defined`, taking down every route and worker sharing the chunk. The import
 * resolves once and is module-cached after that.
 *
 * This module has no logging of its own, so the end-to-end suite can read
 * report text with it; the callers say what failed.
 */
import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

// Structural types for the slice of the pdf.js API used here and in the
// rasterizer. Type-only, so nothing evaluates pdf.js for its types.
export interface PdfViewport {
  width: number;
  height: number;
  convertToViewportPoint(x: number, y: number): number[];
}
export interface PdfCanvas {
  width: number;
  height: number;
  toBuffer(mime: "image/jpeg", quality?: number): Buffer;
}
export interface PdfContext2D {
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
/** A text-layer item; marked-content items carry no `str` and are skipped. */
export interface PdfTextItem {
  str?: string;
  hasEOL?: boolean;
  transform?: number[];
  width?: number;
  height?: number;
}
export interface PdfPage {
  getViewport(opts: { scale: number }): PdfViewport;
  render(opts: {
    canvasContext: unknown;
    viewport: PdfViewport;
    canvas: unknown;
  }): { promise: Promise<void> };
  cleanup(): void;
  getTextContent(): Promise<{ items: PdfTextItem[] }>;
}
export interface PdfDocument {
  numPages: number;
  canvasFactory: PdfCanvasFactory;
  getPage(pageNumber: number): Promise<PdfPage>;
}
export interface PdfLoadingTask {
  promise: Promise<PdfDocument>;
  destroy(): Promise<void>;
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
interface PdfjsModule {
  getDocument(opts: PdfDocumentOptions): PdfLoadingTask;
}

/**
 * Where pdf.js finds the data it does not carry in its JS: the standard 14
 * fonts (a PDF that names Helvetica or Times without embedding them), the
 * CMaps (CID fonts with a predefined encoding), and the wasm image decoders
 * (JPEG 2000, JBIG2). In a browser pdf.js fetches these from a URL; under
 * Node they are read from disk, and without a directory pdf.js draws the text
 * without glyphs and cannot map a predefined-CMap font to characters.
 *
 * The runtime image carries no system fonts at all, so nothing else catches
 * that: a letter set in a non-embedded font rendered as an empty page in the
 * container while it rendered correctly on a workstation, where the operating
 * system's fonts stood in.
 *
 * Resolved from the working directory with Node's own resolution, which is
 * what finds the hoisted `node_modules/pdfjs-dist` in the standalone image
 * and the pnpm link in a checkout. The specifier is assembled at runtime so
 * the bundler leaves the lookup alone. The ICC profile option is not set: its
 * loader needs a synchronous XMLHttpRequest that Node lacks, and pdf.js falls
 * back to each colour space's alternate.
 */
export interface PdfjsAssets {
  standardFontDataUrl: string;
  cMapUrl: string;
  wasmUrl: string;
  /** The Liberation Sans faces the rasterizer registers as fallback families. */
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
    // Unresolvable: open without the data; the caller says so.
  }
  return cachedAssets;
}

/** Test hook: the asset lookup is per process. */
export function __resetPdfjsAssetsForTests(): void {
  cachedAssets = undefined;
}

/**
 * Start loading a PDF. The caller awaits `task.promise` and always awaits
 * `task.destroy()` afterwards, which also tears the document down.
 */
export async function openPdfDocument(
  data: Uint8Array | Buffer,
): Promise<PdfLoadingTask> {
  const pdfjs =
    (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as PdfjsModule;
  const assets = resolvePdfjsAssets();
  return pdfjs.getDocument({
    // A copy: pdf.js transfers the buffer it is given to its worker.
    data: new Uint8Array(data),
    verbosity: 0, // VerbosityLevel.ERRORS: no console noise on odd PDFs.
    isEvalSupported: false, // never eval font programs (defence in depth).
    // There are no system fonts to use: substitutes come from pdf.js' own
    // standard font data (and, when rendering, the registered fallbacks).
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
}

/** Vertical gap (pt) past which the next item starts a new line. */
const LINE_THRESHOLD = 4.6;
/** Horizontal gap (pt) on one line past which the next item is a new cell. */
const CELL_THRESHOLD = 7;

/**
 * One page's text layer as plain text: items in content order, a line break
 * where pdf.js marks one or where the next item sits on a lower line, and a
 * tab between items on one line that are far apart (table cells).
 *
 * This is the layout `pdf-parse` produced with its defaults, kept so that
 * swapping it out did not change what the content index sees.
 */
export async function pageTextLayer(
  page: Pick<PdfPage, "getViewport" | "getTextContent">,
): Promise<string> {
  const viewport = page.getViewport({ scale: 1 });
  const { items } = await page.getTextContent();
  const parts: string[] = [];
  let lastX: number | undefined;
  let lastY: number | undefined;
  let lineHeight = 0;
  for (const item of items) {
    if (typeof item.str !== "string") continue;
    const transform = item.transform ?? [1, 0, 0, 1, 0, 0];
    const [x = 0, y = 0] = viewport.convertToViewportPoint(
      transform[4] ?? 0,
      transform[5] ?? 0,
    );
    let str = item.str;
    if (lastY !== undefined) {
      const gap = Math.abs(lastY - y);
      if (gap > LINE_THRESHOLD) {
        const previous = parts.at(-1);
        const opensLine =
          str.startsWith("\n") || (str.trim() === "" && item.hasEOL === true);
        if (
          previous !== undefined &&
          !previous.endsWith("\n") &&
          !opensLine &&
          gap - 1 > lineHeight
        ) {
          parts.push("\n");
          lineHeight = 0;
        }
      } else if (
        gap < LINE_THRESHOLD &&
        lastX !== undefined &&
        Math.abs(lastX - x) > CELL_THRESHOLD
      ) {
        str = `\t${str}`;
      }
    }
    parts.push(str);
    lastX = x + (item.width ?? 0);
    lastY = y;
    lineHeight = Math.max(lineHeight, item.height ?? 0);
    if (item.hasEOL) parts.push("\n");
    if (item.hasEOL || str.endsWith("\n")) lineHeight = 0;
  }
  return parts.join("");
}

/**
 * The text layer of the first `maxPages` pages, each page followed by a blank
 * line. Throws what pdf.js throws (a malformed file, a password, a page that
 * will not parse); the document is torn down either way.
 */
export async function readPdfText(
  data: Uint8Array | Buffer,
  maxPages = Number.POSITIVE_INFINITY,
): Promise<string> {
  const task = await openPdfDocument(data);
  try {
    const doc = await task.promise;
    const last = Math.min(doc.numPages, maxPages);
    let text = "";
    for (let pageNumber = 1; pageNumber <= last; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      try {
        text += `${await pageTextLayer(page)}\n\n`;
      } finally {
        page.cleanup();
      }
    }
    return text;
  } finally {
    try {
      await task.destroy();
    } catch {
      // Best-effort teardown; a destroy failure must not mask the result.
    }
  }
}
