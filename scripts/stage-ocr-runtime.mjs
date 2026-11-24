#!/usr/bin/env node
/**
 * Stage the server's OCR engine as a flat `node_modules` tree:
 *
 *   node scripts/stage-ocr-runtime.mjs <out-dir>
 *
 * writes `<out-dir>/tesseract.js`, `<out-dir>/tesseract.js-core` and the four
 * packages tesseract.js loads in Node, as real files (no pnpm symlinks). The
 * Dockerfile copies the result over the standalone output's `node_modules`.
 *
 * Why a stage of its own. The engine runs in the reader's child process
 * (`src/lib/documents/ocr-engine.mjs`, started by path), so the standalone
 * tracer never sees it, and tesseract.js starts its WebAssembly engine in a
 * worker thread from a file it names at run time, which no tracer follows
 * either. Copying exactly what that path loads is the honest way to ship it.
 *
 * What is copied:
 *   - tesseract.js: `package.json`, `LICENSE.md` and `src/` (the browser
 *     bundle in `dist/` is not loaded in Node);
 *   - tesseract.js-core: the three full builds (plain, SIMD, relaxed SIMD),
 *     each as its `.js` loader and `.wasm`; the Node worker picks one by
 *     feature detection. Full, not the smaller LSTM-only ones the browser
 *     loads: tesseract.js 7's Node loader (`src/worker-script/node/getCore.js`)
 *     compares the boolean it is handed with the engine-mode numbers, never
 *     matches, and so always asks for a full build, whatever the engine mode.
 *     The inlined `.wasm.js` copies stay out. `ocr-runtime-stage.test.ts`
 *     runs a real read from the staged tree alone, so a release that changes
 *     which file it loads fails there;
 *   - regenerator-runtime, is-url, bmp-js and wasm-feature-detect, which the
 *     Node worker requires. zlibjs, idb-keyval and node-fetch serve the
 *     browser or an old Node and are left out.
 *
 * The language data is not here: `scripts/stage-tesseract-assets.mjs` places
 * it in `public/tesseract/lang`, where the browser reads it as well.
 */
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const out = process.argv[2];
if (!out) {
  console.error("usage: node scripts/stage-ocr-runtime.mjs <out-dir>");
  process.exit(2);
}
const outDir = resolve(out);

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const fromRepo = createRequire(join(repoRoot, "package.json"));
const pkgDir = (require, name) =>
  dirname(require.resolve(`${name}/package.json`));

const tesseractDir = pkgDir(fromRepo, "tesseract.js");
// The engine's own dependencies resolve from its location, as pnpm lays
// them out.
const fromTesseract = createRequire(join(tesseractDir, "package.json"));

/** [package, files and directories inside it] */
const PACKAGES = [
  [tesseractDir, "tesseract.js", ["package.json", "LICENSE.md", "src"]],
  [
    pkgDir(fromTesseract, "tesseract.js-core"),
    "tesseract.js-core",
    [
      "package.json",
      "LICENSE",
      "index.js",
      ...[
        "tesseract-core",
        "tesseract-core-simd",
        "tesseract-core-relaxedsimd",
      ].flatMap((build) => [`${build}.js`, `${build}.wasm`]),
    ],
  ],
  ...["regenerator-runtime", "is-url", "bmp-js", "wasm-feature-detect"].map(
    (name) => [pkgDir(fromTesseract, name), name, ["."]],
  ),
];

rmSync(outDir, { recursive: true, force: true });
let copied = 0;
for (const [from, name, entries] of PACKAGES) {
  const target = join(outDir, name);
  mkdirSync(target, { recursive: true });
  for (const entry of entries) {
    cpSync(join(from, entry), join(target, entry), {
      recursive: true,
      dereference: true,
      // A package's own nested node_modules is never part of what it loads.
      filter: (src) => !src.includes(`${name}/node_modules`),
    });
    copied += 1;
  }
}
console.log(
  `stage-ocr-runtime: ${PACKAGES.length} packages (${copied} entries) -> ${outDir}`,
);
