/**
 * The mutation run measures what it says it measures.
 *
 * Three ways it stopped doing so, each one silent until a report was read by
 * hand:
 *
 *  - a mutated file that no module in `stryker.floors.json` claimed was
 *    skipped by the floor check, so `seizures-backup-schema.ts` scored 0 %
 *    every night and nothing failed;
 *  - the backup slices were mutated while the tests that exercise them
 *    (`src/lib/export/__tests__/`) were not in the mutation test set, so
 *    eleven slices scored 0 % for want of a test that existed;
 *  - an include pattern or a floor path that matches nothing still reads as
 *    coverage to anyone skimming the config.
 *
 * This holds the three configs to each other before a nightly run has to:
 * every mutated file belongs to a module, every module path reaches a
 * mutated file, every include pattern finds a test, and every test in the
 * `__tests__` folder next to a mutated file that imports it (without mocking
 * it away) is in the mutation test set. `scripts/mutation-floors.mjs` makes
 * the same first check against the report itself.
 *
 * Mutation check: drop `seizures-backup-schema.ts` from the backup module,
 * or the export folder from `vitest.mutation.config.mts`, and a case here
 * names the file.
 */
import { existsSync, globSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import strykerConfig from "../../stryker.config.mjs";
import floors from "../../stryker.floors.json";
import { readSourceText, requireFloor } from "./helpers/source-files";

const ROOT = resolve(__dirname, "../..");

const expand = (patterns: readonly string[]): string[] =>
  [...new Set(patterns.flatMap((p) => globSync(p, { cwd: ROOT })))]
    .map((p) => p.split("\\").join("/"))
    .sort();

const mutated = requireFloor(
  "files mutated by stryker.config.mjs",
  expand(strykerConfig.mutate),
  60,
);
const mutatedSet = new Set(mutated);

// Loaded by URL: the compiler refuses a static `.mts` import path.
const mutationConfig = (await import(
  pathToFileURL(join(ROOT, "vitest.mutation.config.mts")).href
)) as { default: { test?: { include?: string[] } } };
const includePatterns = mutationConfig.default.test?.include ?? [];
const mutationTests = new Set(
  requireFloor(
    "tests in vitest.mutation.config.mts",
    expand(includePatterns),
    80,
  ),
);

const modules = Object.entries(floors.modules);

/** Resolve an import specifier to a repository-relative source file. */
function resolveImport(fromFile: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = join(ROOT, "src", specifier.slice(2));
  else if (specifier.startsWith(".")) {
    base = resolve(ROOT, dirname(fromFile), specifier);
  } else return null;
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
  ]) {
    if (/\.tsx?$/.test(candidate) && existsSync(candidate)) {
      return relative(ROOT, candidate).split("\\").join("/");
    }
  }
  return null;
}

const IMPORT = /(?:\bfrom\s+|\bimport\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gm;
const MOCK = /\bvi\.(?:mock|doMock)\(\s*["']([^"']+)["']/g;

/** Mutated files a test imports for real, not through a `vi.mock`. */
function mutatedImportsOf(testFile: string): string[] {
  const source = readSourceText(join(ROOT, testFile));
  const mocked = new Set(
    [...source.matchAll(MOCK)].map((m) => resolveImport(testFile, m[1])),
  );
  const found = new Set<string>();
  for (const m of source.matchAll(IMPORT)) {
    const target = resolveImport(testFile, m[1]);
    if (target && mutatedSet.has(target) && !mocked.has(target)) {
      found.add(target);
    }
  }
  return [...found];
}

describe("mutation instrument", () => {
  it("assigns every mutated file to exactly one module", () => {
    const problems: string[] = [];
    for (const file of mutated) {
      const owners = modules
        .filter(([, { paths }]) => paths.some((p) => file.startsWith(p)))
        .map(([name]) => name);
      if (owners.length !== 1) {
        problems.push(
          `${file}: ${owners.length === 0 ? "no module" : owners.join(", ")}`,
        );
      }
    }
    expect(problems).toEqual([]);
  });

  it("points every module path at a mutated file", () => {
    const stale = modules.flatMap(([name, { paths }]) =>
      paths
        .filter((p) => !mutated.some((file) => file.startsWith(p)))
        .map((p) => `${name}: ${p}`),
    );
    expect(stale).toEqual([]);
  });

  it("finds a test for every include pattern", () => {
    const empty = includePatterns.filter((p) => expand([p]).length === 0);
    expect(empty).toEqual([]);
  });

  it("runs every test next to a mutated file that imports it", () => {
    const siblingDirs = [
      ...new Set(mutated.map((file) => `${dirname(file)}/__tests__`)),
    ];
    const siblingTests = requireFloor(
      "tests next to mutated files",
      expand(siblingDirs.map((dir) => `${dir}/**/*.test.{ts,tsx}`)),
      100,
    );
    const required: string[] = [];
    const missing: string[] = [];
    for (const test of siblingTests) {
      const own = mutatedImportsOf(test).filter((file) =>
        test.startsWith(`${dirname(file)}/__tests__/`),
      );
      if (own.length === 0) continue;
      required.push(test);
      if (!mutationTests.has(test)) missing.push(`${test} (${own.join(", ")})`);
    }
    requireFloor("tests that import a mutated neighbour", required, 50);
    expect(missing).toEqual([]);
  });
});
