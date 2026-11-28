/**
 * Reading a scanned PDF or a photo of a document on the server, with no AI
 * and no network: the pages are rendered (`render`, the renderer the vision
 * read uses) and each page image is read by OCR (`ocr`, tesseract in
 * `./ocr-engine.mjs`), both in the reader's child process under its memory
 * ceiling and time limit (`./pdf-isolation.ts`).
 *
 * Every page is its own turn at the reader. A scan of ten pages on a small
 * machine takes minutes, and the reader runs one child at a time for every
 * account on the server; read whole, one long scan would hold back every
 * thumbnail and every read a person is waiting on until it was done. Page by
 * page, the queue puts those in between.
 *
 * Bounds: the first `LOCAL_OCR_MAX_PAGES` pages, each rendered for the `ocr`
 * purpose of `RASTER_PURPOSES` (240 dpi on A4 and US Letter, enough for the
 * small print of a lab table), each read within
 * `LOCAL_OCR_PAGE_TIMEOUT_MS`. Between pages the work stops when the job was
 * aborted (`signal`) or the document is gone (`stillWanted`).
 *
 * The language data is whatever `scripts/stage-tesseract-assets.mjs` placed
 * in `public/tesseract/lang`; a build without it, or without tesseract.js,
 * says so (`serverOcrStatus`) and every scan stays as unread as it was before
 * this module existed.
 */
import { Buffer } from "node:buffer";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { isLocale, type Locale } from "@/lib/i18n/config";
import { readImageDimensions } from "@/lib/image-dimensions";
import { annotate } from "@/lib/logging/context";

import { nativeCanvasSupported } from "./native-canvas-support";
import {
  PdfWorkCancelledError,
  runPdfChild,
  type PdfChildLimits,
} from "./pdf-isolation";
import { PdfReaderUnavailableError } from "./pdfjs";
import { RASTER_MIN_INK_RATIO, RASTER_PURPOSES } from "./rasterize-pdf";
import { MAX_SOURCE_PIXELS } from "./thumbnail";

/** Pages of a scan read by OCR; the rest of a longer one is not. */
export const LOCAL_OCR_MAX_PAGES = 10;

/** JPEG quality of a rendered page; text edges stay sharp at this one. */
const LOCAL_OCR_JPEG_QUALITY = 90;

/**
 * How long one page may take. A current desktop CPU reads a sparse page in
 * one to two seconds and a dense one (seventy table rows) in about eight; a
 * Raspberry Pi 4 is six to eight times slower. Past this the page is not one
 * that finishes.
 */
export const LOCAL_OCR_PAGE_TIMEOUT_MS = 180_000;

/** Opening a scan and rendering its pages: a base plus a share per page. */
const RENDER_TIMEOUT_BASE_MS = 15_000;
const RENDER_TIMEOUT_PER_PAGE_MS = 10_000;

/** Below this many characters a page read found nothing worth keeping. */
const MIN_PAGE_CHARS = 3;

/**
 * The languages a build can carry, in the order the status lists them. Lab
 * reports mix German and English, so those two are read with every time;
 * the account's own language joins them when the build carries its data.
 */
const LANGUAGE_ORDER = [
  "deu",
  "eng",
  "fra",
  "spa",
  "ita",
  "pol",
  "nld",
  "por",
  "rus",
  "kor",
  "chi_sim",
] as const;

/** Read with every time, when present. */
const BASE_LANGUAGES = ["deu", "eng"] as const;

/** The language data for each app locale. */
const LOCALE_LANGUAGE: Record<Locale, (typeof LANGUAGE_ORDER)[number]> = {
  de: "deu",
  en: "eng",
  fr: "fra",
  es: "spa",
  it: "ita",
  pl: "pol",
  ko: "kor",
  nl: "nld",
  "pt-BR": "por",
  ru: "rus",
  "zh-CN": "chi_sim",
};

/** Image types tesseract decodes itself. */
const OCR_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);

/** A test's own language directory, in place of the staged one. */
let languageDirOverride: string | null = null;

/** Where the child finds the language data, relative to the working directory. */
function languageDir(): string {
  return (
    languageDirOverride ??
    join(
      /* turbopackIgnore: true */ process.cwd(),
      "public",
      "tesseract",
      "lang",
    )
  );
}

/** Whether this build carries the OCR engine and which languages it reads. */
export type ServerOcrStatus =
  | { available: true; languages: string[] }
  | { available: false; reason: "engine-missing" | "languages-missing" };

/** Read once per process: the files do not change while it runs. */
let statusCache: ServerOcrStatus | null = null;

export function serverOcrStatus(): ServerOcrStatus {
  if (statusCache) return statusCache;
  const cwd = /* turbopackIgnore: true */ process.cwd();
  const engine =
    existsSync(join(cwd, "src", "lib", "documents", "ocr-engine.mjs")) &&
    existsSync(join(cwd, "node_modules", "tesseract.js", "package.json"));
  if (!engine) {
    statusCache = { available: false, reason: "engine-missing" };
    return statusCache;
  }
  let files: string[] = [];
  try {
    files = readdirSync(languageDir());
  } catch {
    files = [];
  }
  const languages = LANGUAGE_ORDER.filter((lang) =>
    files.includes(`${lang}.traineddata.gz`),
  );
  statusCache =
    languages.length > 0
      ? { available: true, languages }
      : { available: false, reason: "languages-missing" };
  return statusCache;
}

/**
 * Test hook: the status is process-cached by design. `languages` points the
 * reads at a directory of language data the suite staged itself.
 */
export function __resetServerOcrStatusForTests(
  languages: string | null = null,
): void {
  statusCache = null;
  languageDirOverride = languages;
}

/**
 * The languages one read uses: German and English, then the account's own
 * language when it is another one and its data is present. A build carrying
 * neither German nor English reads with what it has, the first present one.
 */
export function readLanguages(
  available: readonly string[],
  locale: string | null | undefined,
): string[] {
  const languages: string[] = BASE_LANGUAGES.filter((lang) =>
    available.includes(lang),
  );
  const own = isLocale(locale) ? LOCALE_LANGUAGE[locale] : null;
  if (own && available.includes(own) && !languages.includes(own)) {
    languages.push(own);
  }
  if (languages.length === 0 && available.length > 0) {
    languages.push(available[0]);
  }
  return languages;
}

export type ServerOcrResult =
  | {
      ok: true;
      text: string;
      /** Pages read by OCR, and the pages the document has. */
      pagesRead: number;
      pageCount: number;
      /** tesseract's mean word confidence over the text, 0 to 100. */
      confidence: number;
    }
  | {
      ok: false;
      /**
       * `unavailable`: this build or this CPU cannot do it (no engine, no
       * language data, a scan on a host whose renderer is off).
       * `empty`: read, and no text came back. `failed`: the engine or the
       * renderer failed, or a page crossed the memory or time bound; the
       * same bytes fail the same way. `cancelled`: the job ended or the
       * document is gone.
       */
      reason: "unavailable" | "empty" | "failed" | "cancelled";
    };

export interface ServerOcrOptions {
  /** The job's abort signal. */
  signal?: AbortSignal;
  /** Asked between pages; false when the document is gone. */
  stillWanted?: () => Promise<boolean>;
  /**
   * The account's locale, asked once when a page is about to be read: its
   * language is read with alongside German and English.
   */
  locale?: () => Promise<string | null>;
  /** Replaces the child runs; the suites use it. */
  run?: PdfChildLimits["run"];
}

/** Whether a MIME is one the server can read by OCR at all. */
export function isServerOcrMime(mime: string): boolean {
  return mime === "application/pdf" || OCR_IMAGE_MIMES.has(mime);
}

/** The reader could not take the work now; the job runs again later. */
function unavailableReader(reason: string): never {
  throw new PdfReaderUnavailableError(
    reason === "busy" ? "busy" : "interrupted",
  );
}

/**
 * The page images to read: the rendered pages of a PDF, or the photo
 * itself (downscaled where the renderer runs, as it is for its preview).
 */
async function pageImages(
  bytes: Buffer,
  mime: string,
  options: ServerOcrOptions,
): Promise<
  | { ok: true; images: Uint8Array[]; pageCount: number; dpi?: number }
  | { ok: false; reason: "unavailable" | "empty" | "failed" }
> {
  const limits = { signal: options.signal, run: options.run };
  if (mime === "application/pdf") {
    // A scan is pictures; without the renderer there is nothing to read.
    if (!nativeCanvasSupported()) return { ok: false, reason: "unavailable" };
    const rendered = await runPdfChild(
      {
        op: "render",
        data: bytes,
        options: {
          maxPages: LOCAL_OCR_MAX_PAGES,
          ...RASTER_PURPOSES.ocr,
          jpegQuality: LOCAL_OCR_JPEG_QUALITY,
          minInkRatio: RASTER_MIN_INK_RATIO,
        },
      },
      {
        ...limits,
        timeoutMs:
          RENDER_TIMEOUT_BASE_MS +
          LOCAL_OCR_MAX_PAGES * RENDER_TIMEOUT_PER_PAGE_MS,
      },
    );
    if (!rendered.ok) {
      if (rendered.reason === "busy" || rendered.reason === "interrupted") {
        unavailableReader(rendered.reason);
      }
      annotate({
        action: { name: "documents.localOcr.renderFailed" },
        meta:
          rendered.reason === "limit"
            ? { reason: "limit", limit: rendered.limit }
            : { reason: rendered.name },
      });
      return { ok: false, reason: "failed" };
    }
    const pages = rendered.value.pages.filter((page) => !page.blank);
    if (pages.length === 0) return { ok: false, reason: "empty" };
    return {
      ok: true,
      images: pages.map((page) => page.jpeg),
      pageCount: rendered.value.pageCount,
      // A JPEG carries no resolution and tesseract sizes its text detection
      // by it; a page up to A4 renders at exactly this one.
      dpi: RASTER_PURPOSES.ocr.dpi,
    };
  }

  if (!OCR_IMAGE_MIMES.has(mime)) return { ok: false, reason: "unavailable" };
  if (nativeCanvasSupported()) {
    // The decode happens in the child, under its bounds, exactly as for the
    // preview; what comes back is a JPEG of a size tesseract reads quickly.
    const scaled = await runPdfChild(
      {
        op: "image-thumbnail",
        data: bytes,
        options: {
          longEdge: RASTER_PURPOSES.ocr.maxLongEdge,
          quality: LOCAL_OCR_JPEG_QUALITY,
          maxPixels: MAX_SOURCE_PIXELS,
        },
      },
      { ...limits, timeoutMs: RENDER_TIMEOUT_BASE_MS * 2 },
    );
    if (!scaled.ok) {
      if (scaled.reason === "busy" || scaled.reason === "interrupted") {
        unavailableReader(scaled.reason);
      }
      return { ok: false, reason: "failed" };
    }
    if (!scaled.value.ok) return { ok: false, reason: "failed" };
    return { ok: true, images: [scaled.value.jpeg], pageCount: 1 };
  }
  // No renderer on this CPU: tesseract decodes the photo itself, inside the
  // child, once its declared size is one the bounds admit.
  const dims = readImageDimensions(
    bytes,
    mime as "image/jpeg" | "image/png" | "image/webp",
  );
  if (!dims || dims.width * dims.height > MAX_SOURCE_PIXELS) {
    return { ok: false, reason: "failed" };
  }
  return { ok: true, images: [new Uint8Array(bytes)], pageCount: 1 };
}

/**
 * Read a scanned PDF or a photo by OCR on this server. Never throws for the
 * document; throws `PdfReaderUnavailableError` when the reader could not take
 * the work now (the job runs again), as the text read does.
 */
export async function readScanText(
  bytes: Buffer,
  mime: string,
  options: ServerOcrOptions = {},
): Promise<ServerOcrResult> {
  const status = serverOcrStatus();
  if (!status.available) return { ok: false, reason: "unavailable" };
  try {
    return await readPages(bytes, mime, status.languages, options);
  } catch (err) {
    if (err instanceof PdfWorkCancelledError) {
      return { ok: false, reason: "cancelled" };
    }
    throw err;
  }
}

async function readPages(
  bytes: Buffer,
  mime: string,
  languages: readonly string[],
  options: ServerOcrOptions,
): Promise<ServerOcrResult> {
  const startedAt = Date.now();
  const source = await pageImages(bytes, mime, options);
  if (!source.ok) return source;
  const langs = readLanguages(
    languages,
    options.locale ? await options.locale() : null,
  );

  const texts: string[] = [];
  let weighted = 0;
  let characters = 0;
  let failedPages = 0;
  for (const [index, image] of source.images.entries()) {
    if (index > 0 && options.stillWanted && !(await options.stillWanted())) {
      return { ok: false, reason: "cancelled" };
    }
    const pageStartedAt = Date.now();
    const read = await runPdfChild(
      {
        op: "ocr",
        data: image,
        options: {
          languages: langs,
          langPath: languageDir(),
          ...(source.dpi ? { dpi: source.dpi } : {}),
        },
      },
      {
        timeoutMs: LOCAL_OCR_PAGE_TIMEOUT_MS,
        signal: options.signal,
        run: options.run,
      },
    );
    if (!read.ok) {
      if (read.reason === "busy" || read.reason === "interrupted") {
        unavailableReader(read.reason);
      }
      failedPages += 1;
      annotate({
        action: { name: "documents.localOcr.pageFailed" },
        meta:
          read.reason === "limit"
            ? { page: index + 1, reason: "limit", limit: read.limit }
            : { page: index + 1, reason: read.name },
      });
      continue;
    }
    const text = read.value.text.trim();
    annotate({
      action: { name: "documents.localOcr.page" },
      meta: {
        page: index + 1,
        pages: source.images.length,
        ms: Date.now() - pageStartedAt,
        chars: text.length,
        confidence: Math.round(read.value.confidence),
      },
    });
    if (text.length < MIN_PAGE_CHARS) continue;
    texts.push(text);
    weighted += read.value.confidence * text.length;
    characters += text.length;
  }

  annotate({
    action: { name: "documents.localOcr.read" },
    meta: {
      pages: source.images.length,
      pageCount: source.pageCount,
      pagesWithText: texts.length,
      failedPages,
      ms: Date.now() - startedAt,
      languages: langs.join("+"),
    },
  });
  if (texts.length === 0) {
    return { ok: false, reason: failedPages > 0 ? "failed" : "empty" };
  }
  return {
    ok: true,
    text: texts.join("\n\n"),
    pagesRead: source.images.length,
    pageCount: source.pageCount,
    confidence: characters > 0 ? weighted / characters : 0,
  };
}
