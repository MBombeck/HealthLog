/**
 * Structural guard: the server runs one pdf.js, and only one module opens it.
 *
 * ## The failure this freezes (GitHub #1277)
 *
 * Under Node, pdf.js keeps its in-process worker on `globalThis.pdfjsWorker`,
 * and whichever copy opens a document first owns it until the process exits.
 * Local text extraction went through `pdf-parse`, which pinned its own, older
 * pdfjs-dist, while the rasterizer ran the app's. Whichever ran first broke
 * the other with "The API version "6.4.299" does not match the Worker version
 * "5.4.296"": after a text extraction every thumbnail and every vision read
 * of a scan failed, after a raster every local text extraction failed without
 * a word, until a restart. Nothing in the gate noticed, because each path
 * passed on its own and the image tracing shipped every `pdfjs-dist@*` the
 * store held.
 *
 * ## What it proves and what it does not
 *
 *   - package.json pins pdfjs-dist exactly and lists no pdf-parse.
 *   - The lockfile resolves exactly one pdfjs-dist, the version package.json
 *     pins, and no package in it depends on pdfjs-dist except the app itself.
 *     A new dependency that brings its own pdf.js, even the same version,
 *     fails here and has to be looked at; every line of the lockfile that
 *     names pdfjs-dist is either understood or reported.
 *   - The checkout resolves that same version from the working directory,
 *     which is how the server finds it.
 *   - No runtime module under `src/` imports pdf-parse, and none imports
 *     pdfjs-dist (a type-only import included) except
 *     `src/lib/documents/pdfjs.ts`, so the text read and the rasterizer open
 *     documents with the same options. Comments are stripped first, so prose
 *     that names a package does not count.
 *
 * It does not prove the image carries one copy; the Dockerfile hoists the
 * pinned version by name and the tracing glob can only find what the lockfile
 * installed. The behaviour itself is pinned by the two `pdfjs-one-version-*`
 * tests under `src/lib/documents/__tests__/`, one per order, each in a
 * process of its own.
 */
import { createRequire } from "node:module";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  readSourceFolder,
  readSourceText,
  stripComments,
} from "./helpers/source-files";

const ROOT = process.cwd();
/** Relative to `src/`. */
const LOADER = "lib/documents/pdfjs.ts";

const pkg = JSON.parse(readSourceText(join(ROOT, "package.json"))) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const pinned =
  pkg.dependencies?.["pdfjs-dist"] ?? pkg.devDependencies?.["pdfjs-dist"];

/** Every lockfile line naming pdfjs-dist, sorted into what it means. */
function readLockfile(lockfile: string): {
  versions: Set<string>;
  rootImporters: number;
  unexplained: string[];
} {
  const lines = lockfile.split("\n");
  const versions = new Set<string>();
  let rootImporters = 0;
  const unexplained: string[] = [];
  lines.forEach((line, i) => {
    if (!line.includes("pdfjs-dist")) return;
    // A resolved copy: `  pdfjs-dist@6.4.299:` in `packages:` and again in
    // `snapshots:` (where a peer suffix in parentheses may follow).
    const resolved =
      /^ {2}'?pdfjs-dist@(\d+\.\d+\.\d+[\w.+-]*)(?:\(.*\))?'?:/.exec(line);
    if (resolved) {
      versions.add(resolved[1]!);
      return;
    }
    // The app's own entry under `importers:`, followed by its specifier.
    if (
      /^ {6}pdfjs-dist:\s*$/.test(line) &&
      /^\s+specifier:/.test(lines[i + 1] ?? "")
    ) {
      rootImporters++;
      return;
    }
    // Anything else is another package depending on pdfjs-dist, an
    // override, or a spelling this reader does not know: all reported.
    unexplained.push(`${i + 1}: ${line.trim()}`);
  });
  return { versions, rootImporters, unexplained };
}

/** A static import, a re-export, a dynamic import or a require of `name`. */
function importOf(name: string): RegExp {
  return new RegExp(
    String.raw`(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["']` +
      name +
      String.raw`(?:/[^"']*)?["']`,
  );
}
const PDFJS_IMPORT = importOf("pdfjs-dist");
const PDF_PARSE_IMPORT = importOf("pdf-parse");

/** The modules whose comment-free source matches `pattern`, sorted. */
function importers(files: Map<string, string>, pattern: RegExp): string[] {
  return [...files]
    .filter(([, source]) => pattern.test(source))
    .map(([path]) => path)
    .sort();
}

/**
 * Runtime modules under `src/`, keyed by their path relative to it, with
 * comments stripped. The suites, mocks and generated client are not loaded
 * by the server.
 */
function runtimeSources(): Map<string, string> {
  return new Map(
    readSourceFolder("src", {
      floor: 1000,
      extensions: [
        ".ts",
        ".tsx",
        ".mts",
        ".cts",
        ".js",
        ".jsx",
        ".mjs",
        ".cjs",
      ],
      include: (rel) =>
        !rel.startsWith("generated/") &&
        !rel.split("/").includes("__tests__") &&
        !rel.split("/").includes("__mocks__") &&
        !/\.(?:test|spec)\.[mc]?[tj]sx?$/.test(rel),
    }).map(([rel, source]) => [rel, stripComments(source)]),
  );
}

describe("one pdf.js (#1277)", () => {
  it("package.json pins pdfjs-dist exactly and lists no pdf-parse", () => {
    expect(pinned, "pdfjs-dist is a direct dependency").toMatch(
      /^\d+\.\d+\.\d+$/,
    );
    expect(pkg.dependencies?.["pdf-parse"]).toBeUndefined();
    expect(pkg.devDependencies?.["pdf-parse"]).toBeUndefined();
  });

  it("the lockfile resolves one pdfjs-dist, and only the app depends on it", () => {
    const lock = readLockfile(readSourceText(join(ROOT, "pnpm-lock.yaml")));
    expect(lock.unexplained, "lockfile lines naming pdfjs-dist").toEqual([]);
    expect([...lock.versions]).toEqual([pinned]);
    expect(lock.rootImporters).toBe(1);
  });

  it("the checkout resolves the pinned copy", () => {
    const anchor = createRequire(join(ROOT, "package.json"));
    const resolved = JSON.parse(
      readSourceText(anchor.resolve("pdfjs-dist/package.json")),
    ) as { version: string };
    expect(resolved.version).toBe(pinned);
  });

  it("no runtime module imports pdf-parse, and only the shared loader imports pdf.js", () => {
    const sources = runtimeSources();
    expect(sources.has(LOADER), `${LOADER} exists`).toBe(true);
    expect(importers(sources, PDF_PARSE_IMPORT)).toEqual([]);
    expect(importers(sources, PDFJS_IMPORT)).toEqual([LOADER]);
  });

  it("the readers catch what they exist to catch", () => {
    const twoCopies = [
      "importers:",
      "  .:",
      "    devDependencies:",
      "      pdfjs-dist:",
      "        specifier: 6.4.299",
      "        version: 6.4.299",
      "packages:",
      "  pdfjs-dist@5.4.296:",
      "  pdfjs-dist@6.4.299:",
      "snapshots:",
      "  some-parser@2.4.5:",
      "    dependencies:",
      "      pdfjs-dist: 5.4.296",
    ].join("\n");
    const lock = readLockfile(twoCopies);
    expect([...lock.versions].sort()).toEqual(["5.4.296", "6.4.299"]);
    expect(lock.unexplained).toEqual(["13: pdfjs-dist: 5.4.296"]);

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

    const sources = new Map(
      [
        [LOADER, 'await import("pdfjs-dist/legacy/build/pdf.mjs")'],
        [
          "a",
          'import type { TextItem } from "pdfjs-dist/types/src/display/api";',
        ],
        ["b", "const m = await import(\n  'pdfjs-dist'\n);"],
        ["c", 'import "pdfjs-dist/legacy/build/pdf.worker.mjs";'],
        ["d", '// once read with import("pdfjs-dist") here'],
        ["e", 'const name = "pdfjs-dist";'],
      ].map(([rel, source]) => [rel!, stripComments(source!)]),
    );
    expect(importers(sources, PDFJS_IMPORT)).toEqual(
      ["a", "b", "c", LOADER].sort(),
    );
  });
});
