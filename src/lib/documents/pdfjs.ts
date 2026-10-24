/**
 * The one pdf.js this server runs, the one way it is opened, and the one way
 * its text layer is read.
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
 * resolves once and is module-cached after that. The type imports below are
 * erased at build, so they load nothing; they let the compiler check every
 * call here against pdf.js' own API.
 *
 * This module has no logging of its own, so the end-to-end suite can read
 * report text with it; the callers say what failed.
 */
import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import type { PDFDocumentLoadingTask } from "pdfjs-dist";
import type {
  TextItem,
  TextMarkedContent,
} from "pdfjs-dist/types/src/display/api";

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
): Promise<PDFDocumentLoadingTask> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const assets = resolvePdfjsAssets();
  return pdfjs.getDocument({
    // A copy: pdf.js transfers the buffer it is given to its worker.
    data: new Uint8Array(data),
    verbosity: 0, // VerbosityLevel.ERRORS: no console noise on odd PDFs.
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

/**
 * Where a text run sits on the page. pdfjs gives each run a text matrix
 * `[a, b, c, d, x, y]`: `x` and `y` are where the run starts, and `d` is its
 * vertical scale, which for upright text is the font size.
 */
interface RunPosition {
  x: number;
  /** The baseline the run sits on. */
  y: number;
  /** Where the run ends: its start plus its width. */
  end: number;
  fontSize: number;
}

function positionOf(run: TextItem): RunPosition {
  const [, , , scaleY, x = 0, y = 0] = run.transform as number[];
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
 */
function startsNewLine(previous: RunPosition, next: RunPosition): boolean {
  return Math.abs(next.y - previous.y) > previous.fontSize / 2;
}

/**
 * Two runs on one line are separate words when the gap between them is wider
 * than a tenth of the font size. Runs that touch, such as a word drawn in two
 * fonts, stay one word.
 */
function leavesWordGap(previous: RunPosition, next: RunPosition): boolean {
  return next.x - previous.end > next.fontSize / 10;
}

/**
 * One page's text: its runs in order, with a line break where a run ends a
 * line or the next one starts a new line, and a space where two runs on one
 * line leave a gap between words.
 */
export function joinTextRuns(
  items: Array<TextItem | TextMarkedContent>,
): string {
  let text = "";
  let previous: RunPosition | null = null;

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
 */
export async function readPdfText(
  data: Uint8Array | Buffer,
  maxPages = Number.POSITIVE_INFINITY,
): Promise<string> {
  const task = await openPdfDocument(data);
  try {
    const doc = await task.promise;
    const pageCount = Math.min(doc.numPages, maxPages);
    const pages: string[] = [];
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
