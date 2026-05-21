/**
 * v1.4.43 QoL (L3) — verify the SW build step + the SW source contract.
 *
 * Pre-fix `public/sw.js` hard-coded `const CACHE_VERSION = "v1.4.38.4"`
 * which drifted four releases stale. The current shape:
 *   - `scripts/generate-sw-version.mjs` writes `self.__APP_VERSION__`
 *     into `public/sw-version.js` from `package.json`.
 *   - `public/sw.js` `importScripts('/sw-version.js')` and reads
 *     `self.__APP_VERSION__` (falling back to a literal).
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { describe, it, expect, afterAll } from "vitest";

const ROOT = join(__dirname, "../..");
const SW_PATH = join(ROOT, "public/sw.js");
const GENERATED_PATH = join(ROOT, "public/sw-version.js");
const SCRIPT_PATH = join(ROOT, "scripts/generate-sw-version.mjs");
const PKG_PATH = join(ROOT, "package.json");

describe("public/sw.js CACHE_VERSION wiring", () => {
  it("does not carry a hard-coded pre-v1.4.43 literal", () => {
    const sw = readFileSync(SW_PATH, "utf8");
    // The exact pre-fix literal — pin out a regression where someone
    // re-hand-codes the version instead of going through the script.
    expect(sw).not.toContain('const CACHE_VERSION = "v1.4.38.4"');
    // The fix routes via `self.__APP_VERSION__`.
    expect(sw).toContain("self.__APP_VERSION__");
  });

  it("loads the generated version file via importScripts", () => {
    const sw = readFileSync(SW_PATH, "utf8");
    expect(sw).toContain("importScripts");
    expect(sw).toContain("/sw-version.js");
  });

  it("falls back to a literal when the import fails", () => {
    const sw = readFileSync(SW_PATH, "utf8");
    // The fallback OR-expression keeps the SW functional in dev mode
    // where the build script has not run. Pin the shape so the fallback
    // can never silently vanish.
    expect(sw).toMatch(/self\.__APP_VERSION__\s*\)?\s*\|\|\s*"v\d/);
  });
});

describe("scripts/generate-sw-version.mjs", () => {
  afterAll(() => {
    // Don't leave the generated artefact behind for the next test run.
    if (existsSync(GENERATED_PATH)) rmSync(GENERATED_PATH);
  });

  it("writes self.__APP_VERSION__ matching package.json", () => {
    execFileSync("node", [SCRIPT_PATH], { stdio: "pipe" });
    expect(existsSync(GENERATED_PATH)).toBe(true);
    const pkg = JSON.parse(readFileSync(PKG_PATH, "utf8"));
    const generated = readFileSync(GENERATED_PATH, "utf8");
    expect(generated).toContain(`self.__APP_VERSION__ = "v${pkg.version}"`);
  });

  it("re-running the script is idempotent (overwrites with same content)", () => {
    execFileSync("node", [SCRIPT_PATH], { stdio: "pipe" });
    const a = readFileSync(GENERATED_PATH, "utf8");
    execFileSync("node", [SCRIPT_PATH], { stdio: "pipe" });
    const b = readFileSync(GENERATED_PATH, "utf8");
    expect(b).toBe(a);
  });
});
