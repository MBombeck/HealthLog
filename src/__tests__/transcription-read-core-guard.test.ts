/**
 * Every report transcription reads through one core, under one set of limits.
 *
 * Two surfaces turn a report into rows a person reviews: the lab scan (Labs →
 * Add → Scan a document) and the document extraction (Documents → a document
 * → Extract lab values, and the lab staging after a document is read). Each
 * used to carry its own copy of the read. When a long multi-page report
 * outgrew one call, the lab scan learned to read it a page or a part at a
 * time under a raised ceiling and to keep a cut answer's complete rows; the
 * document extraction kept its single whole-document call, so the same report
 * was read one way and failed the other as "Couldn't read the document. Try a
 * clearer copy." Each surface passed its own tests.
 *
 * So the class is pinned here, structurally and by behaviour:
 *   - a transcription read's output ceiling is set in exactly one file, the
 *     core (`lib/documents/ocr-read.ts`), and its timeout is read only there
 *     and in the deadline that plans the reads;
 *   - both surfaces read through `runOcrReads` and dial no provider
 *     themselves;
 *   - both background runs plan their reads on the same deadline;
 *   - a lab read and a document read, text and vision, go out with the same
 *     limits.
 *
 * Its limit, stated: the structural cases are text matchers over `src/lib`. A
 * third surface that builds its own completion under a different budget key
 * would not be named here; one that copies the `ocrExtract` ceiling would.
 */
import { describe, expect, it } from "vitest";

import { AI_BUDGETS } from "@/lib/ai/ai-budgets";
import type { CompletionParams } from "@/lib/ai/types";
import { inboundChunkParams } from "@/lib/documents/extract";
import { ocrReadParams, type OcrChunk } from "@/lib/documents/ocr-read";
import { ocrChunkParams } from "@/lib/labs/ocr-extract";

import {
  readSource,
  readSourceFolder,
  requireFloor,
  stripComments,
} from "./helpers/source-files";

const LIB = new Map(
  readSourceFolder("src/lib", {
    floor: 1500,
    include: (rel) => !rel.includes("__tests__") && !rel.endsWith(".test.ts"),
  }).map(([rel, text]) => [rel, stripComments(text)] as const),
);

/** Files under `src/lib` whose code matches `pattern`, sorted. */
function filesMatching(pattern: RegExp): string[] {
  return [...LIB].filter(([, text]) => pattern.test(text)).map(([rel]) => rel);
}

/** The text of one top-level function in `source`, up to the next one. */
function functionBody(source: string, name: string): string {
  const start = source.search(new RegExp(`\\bfunction\\s+${name}\\s*\\(`));
  expect(start, `function ${name}`).toBeGreaterThanOrEqual(0);
  const rest = source.slice(start + 1);
  const next = rest.search(/\n(?:export\s+)?(?:async\s+)?function\s+\w+\s*\(/);
  return next < 0 ? rest : rest.slice(0, next);
}

describe("transcription read core", () => {
  it("sets a read's output ceiling in the core and nowhere else", () => {
    const setters = filesMatching(
      /\bmaxTokens\s*:\s*AI_BUDGETS\.ocrExtract\.maxTokens\b/,
    );
    requireFloor("files setting the transcription ceiling", setters, 1);
    expect(setters).toEqual(["documents/ocr-read.ts"]);
  });

  it("reads the per-read timeout in the core and in the deadline that plans the reads, nowhere else", () => {
    const readers = filesMatching(/\bAI_BUDGETS\.ocrExtract\.timeoutMs\b/);
    requireFloor("files reading the transcription timeout", readers, 2);
    expect(readers).toEqual([
      "documents/ocr-read.ts",
      "jobs/document-ai-run.ts",
    ]);
  });

  it("has both surfaces read through runOcrReads and dial no provider themselves", () => {
    for (const rel of ["labs/ocr-extract.ts", "documents/extract.ts"]) {
      const text = LIB.get(rel);
      expect(text, rel).toBeDefined();
      expect(text, rel).toMatch(/\brunOcrReads\s*\(/);
      expect(text, rel).not.toMatch(/\.generateCompletion\s*\(/);
    }
  });

  it("plans the lab scan run and the document extract run on the same deadline", () => {
    const worker = stripComments(
      readSource("src/lib/jobs/document-ai-run.ts", [
        "function runLabsOcr",
        "function runDocumentExtractRead",
        "function ocrReadSchedule",
      ]),
    );
    for (const fn of ["runLabsOcr", "runDocumentExtractRead"]) {
      expect(functionBody(worker, fn), fn).toMatch(/\bocrReadSchedule\s*\(/);
    }
  });

  it("sends a lab read and a document read, text and vision, under the same limits", () => {
    const limits = (p: CompletionParams) => ({
      maxTokens: p.maxTokens,
      timeoutMs: p.timeoutMs,
      temperature: p.temperature,
      responseFormat: p.responseFormat,
      reasoning: p.reasoning,
    });
    const expected = limits(ocrReadParams({ system: "s", user: "u" }));
    expect(expected.maxTokens).toBe(AI_BUDGETS.ocrExtract.maxTokens);
    expect(expected.timeoutMs).toBe(AI_BUDGETS.ocrExtract.timeoutMs);

    const text: OcrChunk = { text: "Hb 14,2 g/dl", pages: [] };
    const page: OcrChunk = {
      images: [{ mediaType: "image/jpeg", dataBase64: "AAAA" }],
      documents: [],
      pages: [2],
      pageTexts: [{ page: 2, text: "Hb 14,2 g/dl" }],
    };
    const reads = {
      "lab text": ocrChunkParams("text", text, 0, 2),
      "lab page": ocrChunkParams("vision", page, 1, 3, 3),
      "document text": inboundChunkParams("text", text, 0, 2),
      "document page": inboundChunkParams("vision", page, 1, 3, 3),
    };
    for (const [name, params] of Object.entries(reads)) {
      expect(limits(params), name).toEqual(expected);
    }
  });
});
