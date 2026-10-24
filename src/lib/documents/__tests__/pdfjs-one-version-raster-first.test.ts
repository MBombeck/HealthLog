import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

/**
 * Text extraction and rasterising run in one process. In Node, pdfjs keeps its
 * worker in one global, `globalThis.pdfjsWorker`. When `pdf-parse` brought its
 * own pdfjs (5.4.296) beside the app's (6.4.299), the copy that ran first set
 * that global, and the other copy refused it: "The API version "6.4.299" does
 * not match the Worker version "5.4.296"". Thumbnails then failed as
 * `raster-failed`, vision reads of a PDF answered 422, and the local text index
 * stayed empty with no log line. The fix: read the text with the app's own
 * pdfjs.
 *
 * This file rasterises first and extracts text second. Its twin in this
 * folder runs the reverse order. Each order needs its own file, because a
 * process keeps the first worker it loads.
 *
 * Mutation check: read the text through `pdf-parse` again in
 * `extractPdfText` → the text step here fails.
 */
vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
vi.mock("@/lib/logging/signal", () => ({ logCaught: vi.fn() }));

import { extractPdfText } from "../local-extract";
import { rasterizePdf } from "../rasterize-pdf";

const fixture = readFileSync(
  join(process.cwd(), "tests", "fixtures", "pdf", "fallback-fonts.pdf"),
);

describe("one pdfjs for text and raster: raster first", () => {
  it("rasterises, extracts and rasterises again in one process", async () => {
    // The order only means something in a process that has not opened a PDF.
    expect(
      (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker,
      "this file must run in a process of its own",
    ).toBeUndefined();

    const first = await rasterizePdf(fixture, 1);
    expect(first.ok).toBe(true);

    const text = await extractPdfText(fixture);
    expect(text.ok).toBe(true);

    const again = await rasterizePdf(fixture, 1);
    expect(again.ok).toBe(true);
  });
});
