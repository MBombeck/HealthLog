// @ts-check
/**
 * The one pdf.js this server runs, the one way it is opened, and everything
 * done with an open document: reading its text layer and rendering pages.
 *
 * The server never runs this module in its own process. A PDF is untrusted
 * input whose cost is set by whoever wrote it: an image a few hundred bytes
 * long can declare twenty thousand pixels square and make pdf.js allocate
 * gigabytes while decoding it, and a content stream can keep the parser busy
 * for minutes. Both used to happen inside the web process, where they took
 * every user's requests down with them. Every caller now goes through
 * `./pdf-isolation.ts`, which runs this module in a child process
 * (`./pdf-child.mjs`) under a memory ceiling and a time limit; a document that
 * crosses either one ends the child, not the server. The suites still import
 * it directly to test the reading and rendering themselves.
 *
 * It is plain JavaScript because the child runs it with plain Node, from the
 * checkout and from the standalone image alike; `@ts-check` keeps the
 * compiler on it all the same. It imports nothing from the app, and it logs
 * nothing: the caller in the server says what happened.
 *
 * Under Node, pdf.js does not start a worker thread: it loads its worker code
 * into the same process and keeps it on `globalThis.pdfjsWorker`. Whichever
 * copy of pdf.js opens a document first owns that global until the process
 * exits, and any other copy then refuses every document with "The API version
 * … does not match the Worker version …" (#1277). This is the only module
 * that loads pdf.js; `src/__tests__/single-pdfjs-guard.test.ts` keeps a
 * second copy out.
 *
 * pdf.js is loaded lazily with a runtime `import()`: its module top level
 * reads the browser-only `DOMMatrix` global, and a static import in a module
 * the server bundles would evaluate it at instantiation.
 */
import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** @typedef {import("pdfjs-dist").PDFDocumentLoadingTask} PDFDocumentLoadingTask */
/** @typedef {import("pdfjs-dist/types/src/display/api").TextItem} TextItem */
/** @typedef {import("pdfjs-dist/types/src/display/api").TextMarkedContent} TextMarkedContent */

/**
 * The largest image, in pixels, pdf.js decodes; a larger one is left out of
 * the page and the rest renders. pdf.js decodes an image at the size the file
 * declares, whatever size the page is drawn at, so without this a 400 KB file
 * declaring a 20000 x 20000 image allocated about 7 GB. Decoding costs about
 * 21 bytes per pixel on top of the reader's own 120 MB, so this keeps one
 * image inside the child's memory ceiling (`PDF_CHILD_MEMORY_MB` in
 * `./pdf-isolation.ts`). A 300 dpi A3 scan is about 17 million pixels.
 */
export const PDF_MAX_IMAGE_PIXELS = 20_000_000;

/**
 * Where pdf.js finds the data it does not carry in its JS: the standard 14
 * fonts (a PDF that names Helvetica or Times without embedding them), the
 * CMaps (CID fonts with a predefined encoding), and the wasm image decoders
 * (JPEG 2000, JBIG2). Under Node they are read from disk, and without a
 * directory pdf.js draws the text without glyphs and cannot map a
 * predefined-CMap font to characters. The runtime image carries no system
 * fonts at all, so nothing else catches that.
 *
 * Resolved from the working directory with Node's own resolution, which is
 * what finds the hoisted `node_modules/pdfjs-dist` in the standalone image
 * and the pnpm link in a checkout. The ICC profile option is not set: its
 * loader needs a synchronous XMLHttpRequest that Node lacks, and pdf.js falls
 * back to each colour space's alternate.
 *
 * @typedef {object} PdfjsAssets
 * @property {string} standardFontDataUrl
 * @property {string} cMapUrl
 * @property {string} wasmUrl
 * @property {string[]} fallbackFonts The Liberation Sans faces registered as fallback families.
 */

/** @type {PdfjsAssets | null | undefined} */
let cachedAssets;

/** @returns {PdfjsAssets | null} */
export function resolvePdfjsAssets() {
  if (cachedAssets !== undefined) return cachedAssets;
  cachedAssets = null;
  try {
    const anchor = createRequire(join(process.cwd(), "package.json"));
    const root = dirname(
      anchor.resolve(["pdfjs-dist", "package.json"].join("/")),
    );
    const fonts = join(root, "standard_fonts");
    /** @type {PdfjsAssets} */
    const assets = {
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
export function __resetPdfjsAssetsForTests() {
  cachedAssets = undefined;
}

/**
 * Start loading a PDF. The caller awaits `task.promise` and always awaits
 * `task.destroy()` afterwards, which also tears the document down.
 *
 * Of pdf.js' resource options only `maxImageSize` acts under Node. The canvas
 * area limit (`canvasMaxAreaInBytes`) only steers its OffscreenCanvas image
 * resizer, which Node does not have, and pdf.js 6 has no eval path left for
 * `isEvalSupported` to switch off. `disableFontFace` is already Node's
 * default and is stated so a later default cannot quietly change it.
 *
 * @param {Uint8Array} data
 * @returns {Promise<PDFDocumentLoadingTask>}
 */
export async function openPdfDocument(data) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const assets = resolvePdfjsAssets();
  return pdfjs.getDocument({
    // A copy: pdf.js transfers the buffer it is given to its worker.
    data: new Uint8Array(data),
    verbosity: 0, // VerbosityLevel.ERRORS: no console noise on odd PDFs.
    // There are no system fonts to use: substitutes come from pdf.js' own
    // standard font data (and, when rendering, the registered fallbacks).
    useSystemFonts: false,
    disableFontFace: true,
    maxImageSize: PDF_MAX_IMAGE_PIXELS,
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

/**
 * Where a text run sits on the page. pdfjs gives each run a text matrix
 * `[a, b, c, d, x, y]`: `x` and `y` are where the run starts, and `d` is its
 * vertical scale, which for upright text is the font size.
 *
 * @typedef {object} RunPosition
 * @property {number} x
 * @property {number} y The baseline the run sits on.
 * @property {number} end Where the run ends: its start plus its width.
 * @property {number} fontSize
 */

/**
 * @param {TextItem} run
 * @returns {RunPosition}
 */
function positionOf(run) {
  const [, , , scaleY, x = 0, y = 0] = /** @type {number[]} */ (run.transform);
  return {
    x,
    y,
    end: x + run.width,
    fontSize: Math.abs(scaleY ?? 0) || run.height || 1,
  };
}

/**
 * The next run is on a new line when its baseline moved by more than half a
 * font size. Runs on one line can sit a little higher or lower (a superscript,
 * a mixed font), so a small shift does not count.
 *
 * @param {RunPosition} previous
 * @param {RunPosition} next
 */
function startsNewLine(previous, next) {
  return Math.abs(next.y - previous.y) > previous.fontSize / 2;
}

/**
 * Two runs on one line are separate words when the gap between them is wider
 * than a tenth of the font size. Runs that touch, such as a word drawn in two
 * fonts, stay one word.
 *
 * @param {RunPosition} previous
 * @param {RunPosition} next
 */
function leavesWordGap(previous, next) {
  return next.x - previous.end > next.fontSize / 10;
}

/**
 * One page's text: its runs in order, with a line break where a run ends a
 * line or the next one starts a new line, and a space where two runs on one
 * line leave a gap between words.
 *
 * @param {Array<TextItem | TextMarkedContent>} items
 * @returns {string}
 */
export function joinTextRuns(items) {
  let text = "";
  /** @type {RunPosition | null} */
  let previous = null;

  for (const item of items) {
    // Marked-content markers carry no text.
    if (!("str" in item)) continue;
    const position = positionOf(item);

    if (previous && !text.endsWith("\n")) {
      if (startsNewLine(previous, position)) {
        text += "\n";
      } else if (leavesWordGap(previous, position) && !/\s$/.test(text)) {
        text += " ";
      }
    }
    text += item.str;
    if (item.hasEOL && !text.endsWith("\n")) text += "\n";

    previous = position;
  }
  return text;
}

/**
 * The text layer of the first `maxPages` pages, one page after another.
 * Throws what pdf.js throws (a malformed file, a password, a page that will
 * not parse); the document is torn down either way.
 *
 * @param {Uint8Array} data
 * @param {number} [maxPages]
 * @returns {Promise<string>}
 */
export async function readTextLayer(data, maxPages = Number.POSITIVE_INFINITY) {
  const task = await openPdfDocument(data);
  try {
    const doc = await task.promise;
    const pageCount = Math.min(doc.numPages, maxPages);
    /** @type {string[]} */
    const pages = [];
    for (let n = 1; n <= pageCount; n++) {
      const page = await doc.getPage(n);
      try {
        pages.push(joinTextRuns((await page.getTextContent()).items));
      } finally {
        page.cleanup();
      }
    }
    return pages.join("\n");
  } finally {
    try {
      await task.destroy();
    } catch {
      // Best-effort teardown; a destroy failure must not mask the result.
    }
  }
}

/**
 * The most text kept from one page's text layer when pages are rendered.
 * Collection stops here while the items are read, so a PDF whose content
 * streams inflate to megabytes of text cannot hold them in memory for the
 * length of a run. A dense lab page is well below it.
 */
export const RASTER_PAGE_TEXT_MAX = 12_000;

/** Marks where a text layer was cut. */
export const TEXT_LAYER_CUT_MARK = "[text layer cut here]";

/**
 * The head of `text` that fits `room` characters: cut at the last space before
 * the limit so no number is cut in half, or hard at the limit when the text
 * has no space to cut at.
 *
 * @param {string} text
 * @param {number} room
 */
function headThatFits(text, room) {
  if (text.length <= room) return text;
  const head = text.slice(0, room);
  const space = head.lastIndexOf(" ");
  return space > 0 ? head.slice(0, space) : head;
}

/**
 * A page's text layer, as far as `pageText` reads it: text runs, and
 * marked-content markers that carry only a `type` and no text.
 *
 * @typedef {object} TextLayerPage
 * @property {() => Promise<{ items: Array<{ str?: string; hasEOL?: boolean; type?: string }> }>} getTextContent
 */

/**
 * A page's text layer, line by line: what the PDF states as characters.
 * Empty for a page without one or on any failure. Past
 * `RASTER_PAGE_TEXT_MAX` it is cut (at a line, else a space, else hard) and
 * marked.
 *
 * @param {TextLayerPage} page
 * @returns {Promise<string>}
 */
export async function pageText(page) {
  const max = RASTER_PAGE_TEXT_MAX;
  try {
    const { items } = await page.getTextContent();
    /** @type {string[]} */
    const lines = [];
    let length = 0;
    let line = "";
    // Cut at the last whole line; only a page whose first line alone runs
    // past the cap keeps part of that line, cut at a space or hard.
    const cut = () => {
      if (lines.length === 0) {
        const room = max - TEXT_LAYER_CUT_MARK.length - 1;
        const head = headThatFits(line.replace(/\s+/g, " ").trim(), room);
        if (head.trim()) lines.push(head.trim());
      }
      lines.push(TEXT_LAYER_CUT_MARK);
      return lines.join("\n");
    };
    /** Adds the line in hand; false when it does not fit. */
    const flush = () => {
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
 *
 * @param {PdfjsAssets} assets
 */
async function registerFallbackFamilies(assets) {
  if (fallbackFamiliesRegistered) return;
  fallbackFamiliesRegistered = true;
  const { GlobalFonts } = await import("@napi-rs/canvas");
  for (const family of ["sans-serif", "serif", "monospace"]) {
    for (const file of assets.fallbackFonts) {
      GlobalFonts.registerFromPath(file, family);
    }
  }
}

/** Test hook: the font registration is per process. */
export function __resetFallbackFamiliesForTests() {
  fallbackFamiliesRegistered = false;
}

/**
 * Share of dark pixels on a rendered page (luminance below half).
 *
 * @param {{ getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray } }} context
 * @param {number} width
 * @param {number} height
 */
function inkRatio(context, width, height) {
  const { data } = context.getImageData(0, 0, width, height);
  let dark = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (
      /** @type {number} */ (data[i]) +
        /** @type {number} */ (data[i + 1]) +
        /** @type {number} */ (data[i + 2]) <
      384
    ) {
      dark++;
    }
  }
  const pixels = data.length / 4;
  return pixels > 0 ? dark / pixels : 0;
}

/**
 * The canvas pdf.js draws into under Node is `@napi-rs/canvas`. pdf.js' own
 * declarations are written for the DOM and type the document's canvas factory
 * as a bare `object`, so the slice used here is named.
 *
 * @typedef {object} RenderTarget
 * @property {{ width: number; height: number; toBuffer(mime: "image/jpeg", quality?: number): Buffer }} canvas
 * @property {{ getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray } }} context
 *
 * @typedef {object} RenderTargetFactory
 * @property {(width: number, height: number) => RenderTarget} create
 * @property {(target: RenderTarget) => void} [destroy]
 */

/**
 * @typedef {object} RenderOptions
 * @property {number} maxPages Pages to render from the first.
 * @property {number} targetLongEdge Longest edge of a rendered page, never upscaled.
 * @property {number} jpegQuality
 * @property {number} minInkRatio Below this share of dark pixels a page counts as blank.
 * @property {boolean} [withText] Also read each rendered page's text layer.
 *
 * @typedef {object} RenderedPage
 * @property {Buffer} jpeg
 * @property {boolean} blank
 * @property {string} [text]
 *
 * @typedef {object} RenderedDocument
 * @property {number} pageCount Pages in the document, rendered or not.
 * @property {RenderedPage[]} pages
 * @property {boolean} assetsMissing Whether pdf.js ran without its font and decoder data.
 */

/**
 * Render the first `maxPages` pages of a PDF to JPEG. Throws what pdf.js
 * throws; the document is torn down either way.
 *
 * @param {Uint8Array} data
 * @param {RenderOptions} options
 * @returns {Promise<RenderedDocument>}
 */
export async function renderPdfPages(data, options) {
  const assets = resolvePdfjsAssets();
  if (assets) await registerFallbackFamilies(assets);

  const task = await openPdfDocument(data);
  try {
    const doc = await task.promise;
    const pageCount = Math.min(doc.numPages, Math.max(1, options.maxPages));
    /** @type {RenderedPage[]} */
    const pages = [];
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      try {
        const base = page.getViewport({ scale: 1 });
        const longEdge = Math.max(base.width, base.height);
        // Cap the long edge, never upscale (scale <= 1).
        const scale =
          longEdge > 0 ? Math.min(1, options.targetLongEdge / longEdge) : 1;
        const viewport = page.getViewport({ scale });

        const factory = /** @type {RenderTargetFactory} */ (doc.canvasFactory);
        const target = factory.create(
          Math.ceil(viewport.width),
          Math.ceil(viewport.height),
        );
        await page.render({
          canvasContext: /** @type {never} */ (target.context),
          viewport,
          canvas: /** @type {never} */ (target.canvas),
        }).promise;
        const blank =
          inkRatio(target.context, target.canvas.width, target.canvas.height) <
          options.minInkRatio;
        const jpeg = target.canvas.toBuffer("image/jpeg", options.jpegQuality);
        factory.destroy?.(target);
        /** @type {RenderedPage} */
        const rendered = { jpeg: Buffer.from(jpeg), blank };
        if (options.withText) rendered.text = await pageText(page);
        pages.push(rendered);
      } finally {
        page.cleanup();
      }
    }
    return { pageCount: doc.numPages, pages, assetsMissing: !assets };
  } finally {
    try {
      await task.destroy();
    } catch {
      // Best-effort teardown; a destroy failure must not mask the result.
    }
  }
}
