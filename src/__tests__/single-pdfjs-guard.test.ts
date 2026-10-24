/**
 * Structural guard: the server runs one pdf.js, and only one module opens it.
 *
 * ## The failure this freezes (GitHub #1277)
 *
 * Under Node, pdf.js keeps its in-process worker on `globalThis.pdfjsWorker`,
 * and whichever copy opens a document first owns it until the process exits.
 * The local text read ran a library that pinned its own, older pdfjs-dist,
 * while the rasterizer ran the app's. Whichever ran first broke the other
 * with "The API version … does not match the Worker version …": after a text
 * read every thumbnail and every vision read of a scan failed, after a render
 * every local text read failed without a word, until a restart. Nothing in
 * the gate noticed, because each path passed on its own and the image tracing
 * shipped every `pdfjs-dist@*` the store held.
 *
 * ## What it proves and what it does not
 *
 *   - The lockfile resolves exactly one pdfjs-dist, the version package.json
 *     pins, and no package in it depends on pdfjs-dist except the app itself.
 *     A new dependency that brings its own pdf.js, even the same version,
 *     fails here and has to be looked at; every line of the lockfile that
 *     names pdfjs-dist is either understood or reported.
 *   - The checkout resolves that same version from the working directory,
 *     which is how the server finds it.
 *   - No production module under `src/` imports pdfjs-dist except
 *     `src/lib/documents/pdfjs.ts`, so both paths open documents with the same
 *     options, and nothing imports pdf-parse.
 *
 * It does not prove the image carries one copy; the Dockerfile hoists the
 * pinned version by name and the tracing glob can only find what the lockfile
 * installed. The behaviour itself is pinned by the two
 * `pdfjs-one-runtime-*` tests under `src/lib/documents/__tests__/`.
 */
import { createRequire } from "node:module";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readSourceFolder, readSourceText } from "./helpers/source-files";

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

/** Production modules under `src/` that import a pdf.js package. */
function pdfjsImporters(files: Map<string, string>): string[] {
  const specifier =
    /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s*)["'](?:pdfjs-dist|pdf-parse)(?:\/[^"']*)?["']/m;
  return [...files]
    .filter(([, source]) => specifier.test(source))
    .map(([path]) => path)
    .sort();
}

/** Production modules under `src/`, keyed by their path relative to it. */
function productionSources(): Map<string, string> {
  return new Map(
    readSourceFolder("src", {
      floor: 1000,
      extensions: [".ts", ".tsx", ".mts", ".js", ".mjs"],
      include: (rel) =>
        !rel.startsWith("generated/") &&
        !rel.includes("__tests__/") &&
        !/\.(?:test|spec)\.[mc]?[tj]sx?$/.test(rel),
    }),
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

  it("only the shared loader imports pdf.js", () => {
    const sources = productionSources();
    expect(sources.has(LOADER), `${LOADER} exists`).toBe(true);
    expect(pdfjsImporters(sources)).toEqual([LOADER]);
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

    const importers = pdfjsImporters(
      new Map([
        [LOADER, 'await import("pdfjs-dist/legacy/build/pdf.mjs")'],
        ["a", 'import { PDFParse } from "pdf-parse";'],
        ["b", "const m = await import(\n  'pdfjs-dist'\n);"],
        ["c", 'import "pdfjs-dist/legacy/build/pdf.worker.mjs";'],
        ["d", '// mentions "pdfjs-dist" in prose only'],
      ]),
    );
    expect(importers).toEqual(["a", "b", "c", LOADER].sort());
  });
});
