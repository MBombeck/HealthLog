/**
 * Structural guard: the server runs one pdfjs.
 *
 * ## The failure this freezes
 *
 * `pdf-parse` brings its own `pdfjs-dist` beside the app's, and under Node
 * every pdfjs copy keeps its worker on the one `globalThis.pdfjsWorker`. While
 * local text extraction went through pdf-parse, whichever copy ran first in a
 * process broke the other: "The API version "6.4.299" does not match the
 * Worker version "5.4.296"". Thumbnails and vision reads failed after a text
 * extraction, and the text extraction failed after a raster.
 *
 * ## What it proves and what it does not
 *
 * No runtime file under `src/` imports `pdf-parse`, so the only pdfjs the
 * server loads is the app's own. Tests may still read generated PDFs back with
 * it; they run in their own processes. The pdfjs-one-version tests prove the
 * two orders in one process; this file stops the import from coming back.
 */
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  readSourceText,
  requireFloor,
  stripComments,
  walkSourceFiles,
} from "./helpers/source-files";

const SRC = join(process.cwd(), "src");

/**
 * Every runtime module under `src/`: the suites, mocks and generated client
 * are not loaded by the server. About 3,400 today; the floor sits below that
 * with headroom, so a walk that comes back short fails instead of passing.
 */
function runtimeFiles(): string[] {
  const files = walkSourceFiles(SRC, {
    floor: 5000,
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
  }).filter(
    (rel) =>
      !rel.startsWith("generated/") &&
      !rel.split("/").includes("__tests__") &&
      !rel.split("/").includes("__mocks__") &&
      !/\.test\.(ts|tsx)$/.test(rel),
  );
  return [...requireFloor("runtime files under src/", files, 3000)];
}

/** A static import, a re-export, a dynamic import or a require of pdf-parse. */
const PDF_PARSE_IMPORT =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["']pdf-parse(?:\/[^"']*)?["']/;

describe("one pdfjs in the server", () => {
  it("no runtime file imports pdf-parse", () => {
    const importers = runtimeFiles().filter((rel) =>
      PDF_PARSE_IMPORT.test(stripComments(readSourceText(join(SRC, rel)))),
    );
    expect(importers).toEqual([]);
  });

  it("recognises each way of importing it", () => {
    for (const line of [
      'import { PDFParse } from "pdf-parse";',
      'import type { PDFParse } from "pdf-parse";',
      'const { PDFParse } = await import("pdf-parse");',
      "const m = require('pdf-parse/worker');",
      'export { PDFParse } from "pdf-parse";',
    ]) {
      expect(PDF_PARSE_IMPORT.test(line), line).toBe(true);
    }
    expect(PDF_PARSE_IMPORT.test('import x from "pdf-parser";')).toBe(false);
  });
});
