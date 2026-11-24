import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { createCanvas } from "@napi-rs/canvas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The OCR engine the image ships is the tree `scripts/stage-ocr-runtime.mjs`
 * stages, and nothing else: the standalone output has no tesseract.js of its
 * own. So the staged tree alone must read a page. This stages it into a
 * directory outside the checkout (no `node_modules` above it to fall back
 * on) and runs a real read in a fresh Node, started the way the child's
 * engine starts it. A tesseract.js release that loads another core file, or
 * a dependency it newly requires, fails here before it fails in a container.
 */
const require = createRequire(import.meta.url);
let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "hl-ocr-runtime-"));
  execFileSync(process.execPath, [
    join(process.cwd(), "scripts", "stage-ocr-runtime.mjs"),
    join(root, "node_modules"),
  ]);
  const langDir = join(root, "lang");
  mkdirSync(langDir);
  const manifest = require.resolve("@tesseract.js-data/eng/package.json");
  copyFileSync(
    join(dirname(manifest), "4.0.0_best_int", "eng.traineddata.gz"),
    join(langDir, "eng.traineddata.gz"),
  );
  const canvas = createCanvas(1000, 200);
  const g = canvas.getContext("2d");
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, 1000, 200);
  g.fillStyle = "#000000";
  g.font = "44px sans-serif";
  g.fillText("Ferritin 80 ng/ml 30 - 400", 30, 110);
  writeFileSync(join(root, "page.png"), canvas.toBuffer("image/png"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("the staged OCR runtime", () => {
  it("carries the engine, its core and nothing from the browser bundle", () => {
    const modules = join(root, "node_modules");
    expect(existsSync(join(modules, "tesseract.js", "src", "index.js"))).toBe(
      true,
    );
    expect(existsSync(join(modules, "tesseract.js", "dist"))).toBe(false);
    expect(
      existsSync(
        join(modules, "tesseract.js-core", "tesseract-core-simd.wasm"),
      ),
    ).toBe(true);
    expect(existsSync(join(modules, "zlibjs"))).toBe(false);
  });

  it("reads a page with nothing but the staged tree", () => {
    const read = [
      'const { default: tesseract } = await import("tesseract.js");',
      'const worker = await tesseract.createWorker(["eng"], 1, { langPath: "lang", cacheMethod: "none", gzip: true });',
      'const { data } = await worker.recognize("page.png");',
      "await worker.terminate();",
      "process.stdout.write(data.text);",
    ].join("\n");
    const text = execFileSync(
      process.execPath,
      ["--input-type=module", "-e", read],
      {
        cwd: root,
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "", NODE_ENV: "production" },
        timeout: 60_000,
      },
    );
    expect(text).toContain("Ferritin 80 ng/ml 30 - 400");
  }, 90_000);
});
