/**
 * How a report is split into reads (`OcrChunk`) before `runOcrReads` reads
 * them: a PDF a page at a time, as many reads as the run's deadline allows; a
 * photo as one read; text in parts at line boundaries. Shared by the lab scan
 * and the document extraction, so a long report is planned the same way
 * whichever surface reads it.
 */
import type { Buffer } from "node:buffer";

import {
  readPdfTextLayer,
  textLayerText,
} from "@/lib/documents/pdf-text-layer";
import { rasterizePdf } from "@/lib/documents/rasterize-pdf";

import type { OcrChunk } from "./ocr-read";

/** The most sequential model calls one read makes: the call and one retry. */
export const OCR_EXTRACT_MODEL_CALLS = 2;

/**
 * The most PDF pages a scan reads, and the most text parts a read without a
 * deadline is split into. A multi-panel hospital report runs to a dozen
 * pages; past this the review screen says which pages were read.
 */
export const OCR_MAX_PAGES = 20;

/**
 * OCR'd text per read. A line of a lab table is about one reading, and this
 * many characters keep a read's JSON well inside the per-read output ceiling.
 * One photo's text is usually below it, so it stays one read.
 */
export const OCR_TEXT_READ_CHARS = 4000;

/**
 * The most OCR'd text one read may carry. Past it the JSON for that much text
 * no longer fits one read's output ceiling, so a part this long is refused up
 * front instead of being read into a certain cut.
 */
export const OCR_TEXT_READ_MAX_CHARS = 8000;

/**
 * What the run's deadline allows. The worker knows the person's response time
 * and the job's expiry; the read only knows how many calls it wants to make.
 */
export interface OcrSchedule {
  /** Sequential model calls that still fit before the run's deadline. */
  maxModelCalls(): number;
  /** Move the run's deadline to cover `modelCalls` sequential calls. */
  arm(modelCalls: number): Promise<void>;
}

/**
 * The most reads one HTTP request makes: the extract route, and the lab
 * staging the index route continues into, both without `Prefer:
 * respond-async` (the iPhone app sends neither). Each read is up to
 * `OCR_EXTRACT_MODEL_CALLS` model calls, so this bounds the request at six
 * calls where an unplanned read of a twenty-page report made forty. A longer
 * document is read in as many reads by sharing its pages or text out between
 * them, and what does not fit is reported as `extractionIncomplete` on the
 * document; a background run, which has a deadline of its own, reads it a
 * page at a time.
 */
export const SYNC_EXTRACT_MAX_READS = 3;

/** The read plan of a request: a fixed number of calls, nothing to arm. */
export const SYNCHRONOUS_READ_SCHEDULE: OcrSchedule = {
  maxModelCalls: () => SYNC_EXTRACT_MAX_READS * OCR_EXTRACT_MODEL_CALLS,
  arm: async () => undefined,
};

/** How many reads the deadline leaves room for. */
export function maxReadsFor(schedule: OcrSchedule): number {
  return Math.max(
    1,
    Math.floor(schedule.maxModelCalls() / OCR_EXTRACT_MODEL_CALLS),
  );
}

/**
 * Split `pageCount` pages into contiguous reads: one page each, unless the
 * deadline allows fewer reads than pages, in which case the pages are shared
 * out evenly. Every page lands in exactly one read.
 */
export function planPageReads(pageCount: number, maxReads: number): number[][] {
  const reads = Math.max(1, Math.min(pageCount, Math.floor(maxReads)));
  const perRead = Math.ceil(pageCount / reads);
  const out: number[][] = [];
  for (let first = 1; first <= pageCount; first += perRead) {
    const last = Math.min(first + perRead - 1, pageCount);
    out.push(Array.from({ length: last - first + 1 }, (_, i) => first + i));
  }
  return out;
}

/**
 * Split OCR'd text into reads at line boundaries (a lab table row is a line,
 * so no reading is cut in half), no more than `maxReads` of them, each about
 * `target` characters. Text that fits one read stays one read.
 */
export function splitOcrText(
  text: string,
  maxReads: number,
  target: number = OCR_TEXT_READ_CHARS,
): string[] {
  const reads = Math.max(1, Math.floor(maxReads));
  const size = Math.max(target, Math.ceil(text.length / reads));
  if (text.length <= size) return [text];
  const parts: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    if (current && current.length + 1 + line.length > size) {
      parts.push(current);
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current) parts.push(current);
  while (parts.length > reads) {
    const last = parts.pop() as string;
    parts[parts.length - 1] = `${parts[parts.length - 1]}\n${last}`;
  }
  return parts;
}

/**
 * Text split into reads of about `target` characters, as many as the
 * deadline allows (at most `OCR_MAX_PAGES`). When the deadline leaves too few
 * reads for the whole text, the parts grow to at most twice `target`; past
 * that the text is read from its start and the parts left over are counted
 * in `unreadParts`, rather than sent in reads too long to come back whole.
 */
export function planTextReads(
  text: string,
  schedule: OcrSchedule,
  target: number,
): { chunks: OcrChunk[]; unreadParts: number } {
  const maxReads = Math.min(maxReadsFor(schedule), OCR_MAX_PAGES);
  let parts = splitOcrText(text, maxReads, target);
  let unreadParts = 0;
  if (parts.some((part) => part.length > target * 2)) {
    const all = splitOcrText(text, Number.POSITIVE_INFINITY, target);
    parts = all.slice(0, maxReads);
    unreadParts = all.length - parts.length;
  }
  return {
    chunks: parts.map((part) => ({ text: part, pages: [] })),
    unreadParts,
  };
}

/** The text layer of these pages, those that have one. */
function pageTextsFor(
  pages: number[],
  texts: string[] | undefined,
): { page: number; text: string }[] {
  if (!texts) return [];
  return pages
    .map((page) => ({ page, text: texts[page - 1]?.trim() ?? "" }))
    .filter((p) => p.text.length > 0);
}

export type OcrVisionMime =
  "image/jpeg" | "image/png" | "image/webp" | "application/pdf";

/** The reads of an image or a PDF, or `ok: false` for a PDF nothing can read. */
export type OcrVisionPlan =
  | {
      ok: true;
      mode: "vision";
      chunks: OcrChunk[];
      /** The PDF's page count, when it was rendered. */
      totalPages?: number;
      /** Set when the PDF is longer than the page cap: only the first pages are read. */
      pageCoverage?: { read: number; total: number };
    }
  /**
   * #1311 — a PDF this server cannot render, for a provider that cannot take
   * it whole, read by its text layer: one text part per page group, as the
   * rendered pages would have been, each read under the text bound. Pages
   * without a text layer (scanned pages), and pages the reads could not take
   * in full, are listed in `unreadPages`.
   */
  | {
      ok: true;
      mode: "text";
      chunks: OcrChunk[];
      /** The pages' text the chunks were cut from, for provenance. */
      ocrText: string;
      totalPages: number;
      pageCoverage?: { read: number; total: number };
      unreadPages: number[];
    }
  | {
      ok: false;
      /**
       * `busy`: the reader could not take the PDF now (busy past the wait a
       * read gets, or its process ended for no measured reason). Not a
       * verdict on the file; the person asks again. `renderFailed`: this PDF
       * would not render on a server that renders PDFs. `rendererUnavailable`:
       * this server cannot render PDF pages at all, and the PDF has no text
       * layer to read instead (a scan).
       */
      reason: "busy" | "renderFailed" | "rendererUnavailable";
    };

/** The page-cap note for a PDF read from its first `read` of `total` pages. */
function coverage(
  read: number,
  total: number,
): { pageCoverage?: { read: number; total: number } } {
  return total > read ? { pageCoverage: { read, total } } : {};
}

/**
 * #1311 — read a PDF this server cannot render by its text layer, in page
 * groups planned as the rendered pages would be.
 */
async function planTextLayerReads(
  bytes: Buffer,
  schedule: OcrSchedule,
  textReadChars: number,
): Promise<OcrVisionPlan> {
  const read = await readPdfTextLayer(bytes, OCR_MAX_PAGES, "documents.ocr");
  if (!read.ok) {
    return {
      ok: false,
      reason:
        read.reason === "busy"
          ? "busy"
          : read.reason === "none"
            ? "rendererUnavailable"
            : "renderFailed",
    };
  }
  const { layer } = read;
  const { chunks, unreadPages } = planTextLayerChunks(
    layer.pages,
    maxReadsFor(schedule),
    textReadChars,
  );
  return {
    ok: true,
    mode: "text",
    chunks,
    ocrText: textLayerText(layer),
    totalPages: layer.pageCount,
    ...coverage(layer.pagesRead, layer.pageCount),
    unreadPages: [...new Set([...layer.pagesWithoutText, ...unreadPages])].sort(
      (a, b) => a - b,
    ),
  };
}

/**
 * The reads of a text layer, page-aware and under the same per-read bound as
 * any other text: a page longer than `target` is read in parts at line
 * boundaries, each part its own read while the deadline allows that many;
 * otherwise the parts are packed into at most `maxReads` reads of about the
 * share the deadline leaves, never past twice `target` (the most one read's
 * answer is sized for). When the reads cannot take it all, the text is read
 * from its start and the pages left over, wholly or in part, are returned in
 * `unreadPages`, as `planTextReads` counts its `unreadParts`.
 */
export function planTextLayerChunks(
  pages: { page: number; text: string }[],
  maxReads: number,
  target: number,
): { chunks: OcrChunk[]; unreadPages: number[] } {
  const reads = Math.max(1, Math.floor(maxReads));
  const units = pages.flatMap(({ page, text }) =>
    splitOcrText(text, Number.POSITIVE_INFINITY, target)
      // A single line past the target stays whole in `splitOcrText`; one
      // that long is cut, so no read can exceed the bound.
      .flatMap((part) =>
        part.length <= target
          ? [part]
          : Array.from({ length: Math.ceil(part.length / target) }, (_, i) =>
              part.slice(i * target, (i + 1) * target),
            ),
      )
      .map((part) => ({ page, text: part })),
  );
  // As many reads as parts: a page (or a page part) per read, as rendered
  // pages are read.
  if (units.length <= reads) {
    return {
      chunks: units.map((u) => ({ text: u.text, pages: [u.page] })),
      unreadPages: [],
    };
  }
  const total = units.reduce((n, u) => n + u.text.length, 0);
  const size = Math.min(target * 2, Math.max(target, Math.ceil(total / reads)));
  const packed: { page: number; text: string }[][] = [];
  let current: { page: number; text: string }[] = [];
  let length = 0;
  for (const unit of units) {
    if (current.length > 0 && length + 2 + unit.text.length > size) {
      packed.push(current);
      current = [];
      length = 0;
    }
    current.push(unit);
    length += (current.length > 1 ? 2 : 0) + unit.text.length;
  }
  if (current.length > 0) packed.push(current);
  const kept = packed.slice(0, reads);
  const unreadPages = [
    ...new Set(packed.slice(reads).flatMap((c) => c.map((u) => u.page))),
  ];
  return {
    chunks: kept.map((chunk) => ({
      text: chunk.map((u) => u.text).join("\n\n"),
      pages: [...new Set(chunk.map((u) => u.page))],
    })),
    unreadPages,
  };
}

/**
 * Plan the reads of an image or a PDF. Every PDF is rendered first: a report
 * of more than one page is read a page at a time, whatever the provider, so
 * no single call has to hold the whole report. A provider that reads PDFs
 * natively still gets the document itself when it is one page, or when it
 * cannot be rendered. With each page's text layer: a digitally produced
 * report states its digits exactly there, and the rendered page alone is a
 * picture at a capped resolution. On a server that cannot render at all, a
 * provider that cannot take the PDF whole reads its text layer instead.
 */
export async function planVisionReads(
  bytes: Buffer,
  mime: OcrVisionMime,
  pdfSupported: boolean,
  schedule: OcrSchedule,
  /** Text per read when the PDF is read by its text layer (the surface's own). */
  textReadChars: number = OCR_TEXT_READ_CHARS,
): Promise<OcrVisionPlan> {
  if (mime !== "application/pdf") {
    return {
      ok: true,
      mode: "vision",
      chunks: [
        {
          images: [{ mediaType: mime, dataBase64: bytes.toString("base64") }],
          documents: [],
          pages: [],
        },
      ],
    };
  }
  const raster = await rasterizePdf(bytes, OCR_MAX_PAGES, { withText: true });
  if (raster.ok && (raster.images.length > 1 || !pdfSupported)) {
    const chunks = planPageReads(
      raster.images.length,
      maxReadsFor(schedule),
    ).map((pages) => ({
      images: pages.map((p) => raster.images[p - 1]),
      documents: [],
      pages,
      pageTexts: pageTextsFor(pages, raster.texts),
    }));
    return {
      ok: true,
      mode: "vision",
      chunks,
      totalPages: raster.pageCount,
      // A PDF longer than the page cap is read from its first pages only,
      // and the person reviewing the rows is the one who needs to know.
      ...coverage(raster.images.length, raster.pageCount),
    };
  }
  if (!pdfSupported && !raster.ok) {
    if (raster.reason === "busy" || raster.reason === "interrupted") {
      return { ok: false, reason: "busy" };
    }
    // Refs #776 — a render failure on a server that renders is this
    // document's; a server that cannot render at all is the server's.
    if (raster.reason !== "unsupported") {
      return { ok: false, reason: "renderFailed" };
    }
    return planTextLayerReads(bytes, schedule, textReadChars);
  }
  return {
    ok: true,
    mode: "vision",
    chunks: [
      {
        images: [],
        documents: [
          {
            mediaType: "application/pdf",
            dataBase64: bytes.toString("base64"),
          },
        ],
        pages: [],
      },
    ],
  };
}
