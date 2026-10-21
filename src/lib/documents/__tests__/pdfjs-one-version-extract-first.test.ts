import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

/**
 * Text extraction and rasterising share one process, and pdfjs keeps its worker
 * on `globalThis.pdfjsWorker`. While `pdf-parse` brought its own pdfjs
 * (5.4.296) beside the app's (6.4.299), whichever ran first installed its
 * worker and the other refused it: "The API version "6.4.299" does not match
 * the Worker version "5.4.296"". Thumbnails failed as `raster-failed`, vision
 * reads of a PDF answered 422 and the local text index stayed empty without a
 * word. Reading the text through the app's own pdfjs is the fix; this file runs
 * extraction first and `pdfjs-one-version-raster-first.test.ts` the reverse,
 * each in a fresh process state.
 *
 * Mutation check: read the text through `pdf-parse` again in `extractPdfText` →
 * the raster step here fails.
 */
vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));

import { extractPdfText } from "../local-extract";
import { rasterizePdf } from "../rasterize-pdf";

const fixture = readFileSync(
  join(process.cwd(), "tests", "fixtures", "pdf", "fallback-fonts.pdf"),
);

describe("one pdfjs for text and raster: text first", () => {
  it("extracts, rasterises and extracts again in one process", async () => {
    const first = await extractPdfText(fixture);
    expect(first.ok).toBe(true);

    const raster = await rasterizePdf(fixture, 1);
    expect(raster.ok).toBe(true);

    const again = await extractPdfText(fixture);
    expect(again).toEqual(first);
  });
});
