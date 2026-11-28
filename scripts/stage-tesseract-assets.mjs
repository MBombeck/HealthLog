#!/usr/bin/env node
/**
 * Stage the in-browser OCR engine under `public/tesseract/`.
 *
 * `src/lib/labs/local-ocr.ts` reads a lab-report photo on the device with
 * tesseract.js. Left at its defaults, tesseract.js fetches its worker, its
 * WebAssembly core and the language data from cdn.jsdelivr.net: the browser
 * of every user who scans a report contacts a third-party CDN, and the
 * production CSP (`worker-src 'self'`, `connect-src 'self'`) refuses those
 * requests, so the feature could not load at all. Serving the same files
 * from the app's own origin removes both problems.
 *
 * What is copied, all from pinned packages in node_modules:
 *   - tesseract.js `dist/worker.min.js`
 *   - the three LSTM-only core builds of tesseract.js-core (plain, SIMD,
 *     relaxed SIMD); the worker picks one by feature detection. LSTM-only
 *     because `createWorker` defaults to OEM 1.
 *   - `4.0.0_best_int` language data, gzipped, which is what OEM 1 loads:
 *     one for each app language. The browser scan reads with `deu` and
 *     `eng`; the server reads scanned documents with those two plus the
 *     account's own language (`src/lib/documents/server-ocr.ts`).
 *
 * Runs as a `prebuild`/`predev` step; the output is gitignored.
 */
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(repoRoot, "public", "tesseract");

const pkgDir = (name) => dirname(require.resolve(`${name}/package.json`));

// tesseract.js-core is a dependency of tesseract.js, not of this project;
// resolve it from tesseract.js's own location so pnpm's strict layout finds it.
const tesseractDir = pkgDir("tesseract.js");
const coreDir = dirname(
  createRequire(join(tesseractDir, "package.json")).resolve(
    "tesseract.js-core/package.json",
  ),
);

const files = [
  [join(tesseractDir, "dist", "worker.min.js"), "worker.min.js"],
  ...[
    "tesseract-core-lstm.wasm.js",
    "tesseract-core-simd-lstm.wasm.js",
    "tesseract-core-relaxedsimd-lstm.wasm.js",
  ].map((file) => [join(coreDir, file), join("core", file)]),
  // Literal specifiers, so the dependency is visible to static analysis.
  // `4.0.0_best_int` is the build every language uses: the compressed
  // integer one, 1.6 MB for Chinese against 19 MB for the package's other
  // build, so the Chinese reader adds a size the image already pays for a
  // Latin language.
  ...[
    ["deu", require.resolve("@tesseract.js-data/deu/package.json")],
    ["eng", require.resolve("@tesseract.js-data/eng/package.json")],
    ["fra", require.resolve("@tesseract.js-data/fra/package.json")],
    ["spa", require.resolve("@tesseract.js-data/spa/package.json")],
    ["ita", require.resolve("@tesseract.js-data/ita/package.json")],
    ["pol", require.resolve("@tesseract.js-data/pol/package.json")],
    ["nld", require.resolve("@tesseract.js-data/nld/package.json")],
    ["por", require.resolve("@tesseract.js-data/por/package.json")],
    ["rus", require.resolve("@tesseract.js-data/rus/package.json")],
    ["kor", require.resolve("@tesseract.js-data/kor/package.json")],
    ["chi_sim", require.resolve("@tesseract.js-data/chi_sim/package.json")],
  ].map(([lang, manifest]) => [
    join(dirname(manifest), "4.0.0_best_int", `${lang}.traineddata.gz`),
    join("lang", `${lang}.traineddata.gz`),
  ]),
];

rmSync(outDir, { recursive: true, force: true });
for (const [from, to] of files) {
  const target = join(outDir, to);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(from, target);
}
console.log(
  `stage-tesseract-assets: ${files.length} files -> public/tesseract`,
);
