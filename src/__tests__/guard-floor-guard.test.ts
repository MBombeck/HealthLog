/**
 * Every structural guard asserts that it found something.
 *
 * A guard that sweeps the tree and compares the result against an allowlist,
 * or against "none of these may exist", passes on an empty sweep. That is not
 * hypothetical here: the Bearer-scope guard stayed green for weeks because its
 * matcher demanded `apiToken.findUnique(` on one line and the one file that
 * mattered wrote it across two. The sweep matched nothing, nothing disagreed
 * with the allowlist, and the guard reported a clean tree.
 *
 * So this reads every guard and fails unless it states a floor — a count it
 * must reach — or is named below with the reason it does not need one.
 *
 * ## Scope
 *
 * Every test file under `src/` named `*-guard.test.ts(x)` or
 * `*-guards.test.ts(x)`, plus every test file that walks a directory
 * (`readdirSync`, `globSync`, `walkSourceFiles`), whatever it is called: the
 * inventories and coverage checks are the same machine under another name.
 *
 * ## What counts as a floor
 *
 * The shapes `analyseGuardSource` recognises: `requireFloor`,
 * `scanSourceMatches`, `toBeGreaterThan(n ≥ 0)`, `toBeGreaterThanOrEqual(n ≥
 * 1)`, `.not.toHaveLength(0)`, `toHaveLength(n ≥ 1)`, an exact
 * `expect(x.length).toBe(n ≥ 1)`, and an exact `toEqual([...])` against a
 * non-empty literal set. A floor on the walk alone (`walkSourceFiles`'s own
 * `floor`) does not count: it proves the tree was read, not that the matcher
 * found anything in it, and the Bearer guard had one.
 *
 * ## Its limit
 *
 * It answers per file. A guard with three matchers and a floor under one of
 * them passes. Reviewers still own the question of which set the floor sits
 * under.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { analyseGuardSource } from "./helpers/guard-floor";
import {
  requireFloor,
  scanSourceMatches,
  walkSourceFiles,
} from "./helpers/source-files";

const SRC = join(process.cwd(), "src");

/**
 * In scope, without a floor, and why that is right. Paths relative to `src/`.
 * An entry that gains a floor, or whose file disappears, fails the run, so the
 * list cannot outlive its reasons.
 */
const NO_FLOOR_NEEDED: Readonly<Record<string, string>> = {
  // Fixed file lists. Each file is read by name, so a missing one throws,
  // and each must positively match the shape it is supposed to keep.
  "__tests__/backup-readers-stream-guard.test.ts":
    "named readers, each must positively reference the streaming reader",
  "__tests__/proxy-relative-redirect-guard.test.ts":
    "named routes, each must positively call relativeRedirect(",
  "__tests__/rotation-walk-keyset-guard.test.ts":
    "named walks, each must positively match the keyset cursor",
  "components/charts/__tests__/touch-action-guard.test.ts":
    "named chart wrappers, each must positively declare touch-pan-y",
  "__tests__/moodlog-removal-guard.test.ts":
    "absence checks over named paths, columns and keys; no matcher to drift",

  // Unit tests of runtime code whose name ends in "guard". They read no
  // source and sweep nothing.
  "app/__tests__/error-chunk-reload-guard.test.ts":
    "unit test of the chunk-reload guard function",
  "app/api/insights/chat/__tests__/route-fence-guard.test.ts":
    "route behaviour test of the chat fence",
  "app/api/insights/chat/__tests__/route-guard.test.ts":
    "route behaviour test of the outbound screen",
  "lib/ai/__tests__/consent-guard.test.ts": "unit test of the consent gate",
  "lib/ai/coach/__tests__/outbound-guard.test.ts":
    "unit test of the outbound screen",
  "lib/analytics/score/__tests__/config-delta-guard.test.ts":
    "unit test of the score delta boundary",
  "lib/medications/__tests__/route-guards.test.ts":
    "unit test of the ownership helper",

  // List a temporary directory the test itself filled.
  "lib/import/__tests__/unzip-health-connect.test.ts":
    "lists the temp directory to show a refused extraction left no file behind",
  "lib/multipart/__tests__/stream-to-disk.test.ts":
    "lists its own temp directory",
};

const NAMED_GUARD = /-guards?\.test\.tsx?$/;

interface Scoped {
  rel: string;
  named: boolean;
  floors: string[];
}

function guardsInScope(): Scoped[] {
  const scoped: Scoped[] = [];
  const tests = walkSourceFiles(SRC, { floor: 3000 })
    .filter((rel) => !rel.startsWith("generated/"))
    .filter((rel) => /\.test\.tsx?$/.test(rel));
  for (const rel of requireFloor("test files under src/", tests, 1500)) {
    const named = NAMED_GUARD.test(rel);
    const report = analyseGuardSource(
      rel,
      readFileSync(join(SRC, rel), "utf8"),
    );
    if (!named && !report.walksDirectories) continue;
    scoped.push({ rel, named, floors: report.floors });
  }
  return scoped;
}

/** Floors that say something about matches, not just about the walk. */
function matchFloors(floors: readonly string[]): string[] {
  return floors.filter((f) => f !== "walkSourceFiles");
}

describe("every structural guard states a floor", () => {
  const scoped = guardsInScope();

  it("finds the guards (this check has a floor too)", () => {
    expect(scoped.filter((g) => g.named).length).toBeGreaterThanOrEqual(100);
    expect(scoped.filter((g) => !g.named).length).toBeGreaterThanOrEqual(40);
  });

  it("each one asserts a floor on what it found, or says why not", () => {
    const missing = scoped
      .filter((g) => matchFloors(g.floors).length === 0)
      .filter((g) => !(g.rel in NO_FLOOR_NEEDED))
      .map((g) => g.rel);
    expect(
      missing,
      "These guards can pass on a sweep that found nothing. Add a floor " +
        "(requireFloor, scanSourceMatches, or expect(count).toBeGreaterThan…) " +
        "pinned at the real count, or name the file in NO_FLOOR_NEEDED with " +
        "the reason it is not a scanner.",
    ).toEqual([]);
  });

  it("names no file in the exemption list that no longer needs it", () => {
    const byRel = new Map(scoped.map((g) => [g.rel, g]));
    const stale = Object.keys(NO_FLOOR_NEEDED).filter((rel) => {
      const g = byRel.get(rel);
      return !g || matchFloors(g.floors).length > 0;
    });
    expect(
      stale,
      "Exempt files that are gone, out of scope, or now carry a floor",
    ).toEqual([]);
  });
});

describe("the floor reader counts what it should and nothing else", () => {
  const floorsOf = (source: string) =>
    matchFloors(analyseGuardSource("probe.test.ts", source).floors);

  it.each([
    ["requireFloor", `requireFloor("x", found, 3);`],
    ["toBeGreaterThan(0)", `expect(found.length).toBeGreaterThan(0);`],
    ["toBeGreaterThanOrEqual(n)", `expect(n).toBeGreaterThanOrEqual(12);`],
    ["a named floor", `expect(n).toBeGreaterThanOrEqual(FLOOR);`],
    ["not.toHaveLength(0)", `expect(found).not.toHaveLength(0);`],
    ["exact length", `expect(found.length).toBe(7);`],
    ["exact non-empty set", `expect(found).toEqual(["lib/a.ts"]);`],
    [
      "scanSourceMatches",
      `scanSourceMatches(root, /x/g, { fileFloor: 10, matchFloor: 2 });`,
    ],
  ])("counts %s", (_label, source) => {
    expect(floorsOf(source)).toHaveLength(1);
  });

  it.each([
    ["a floor in a comment", `// expect(n).toBeGreaterThan(0);`],
    ["a floor in a string", `const s = "expect(n).toBeGreaterThan(0)";`],
    ["a negated floor", `expect(n).not.toBeGreaterThan(0);`],
    ["GreaterThanOrEqual(0)", `expect(n).toBeGreaterThanOrEqual(0);`],
    ["a zero requireFloor", `requireFloor("x", found, 0);`],
    ["a zero matchFloor", `scanSourceMatches(r, /x/g, { matchFloor: 0 });`],
    ["an empty-set equality", `expect(offenders).toEqual([]);`],
    ["a spread-only set", `expect(found).toEqual([...EXPECTED]);`],
    ["toHaveLength(0)", `expect(found).toHaveLength(0);`],
    ["a walk floor alone", `walkSourceFiles(SRC, { floor: 3000 });`],
    [
      "a floor inside it.skip",
      `it.skip("x", () => { expect(n).toBeGreaterThan(0); });`,
    ],
  ])("does not count %s", (_label, source) => {
    expect(floorsOf(source)).toEqual([]);
  });

  it("still notices the walk, so a walker stays in scope", () => {
    const report = analyseGuardSource(
      "probe.test.ts",
      `const files = readdirSync(dir);`,
    );
    expect(report.walksDirectories).toBe(true);
  });
});

describe("the floor helpers refuse an empty answer", () => {
  it("requireFloor throws below the floor and refuses a zero floor", () => {
    expect(() => requireFloor("probe", [], 1)).toThrow(/below the stated/);
    expect(() => requireFloor("probe", [1, 2], 0)).toThrow(/positive/);
    expect(requireFloor("probe", [1, 2], 2)).toEqual([1, 2]);
  });

  it("scanSourceMatches floors files and matches separately", () => {
    const helpers = join(SRC, "__tests__", "helpers");
    const hits = scanSourceMatches(helpers, /export function \w+/g, {
      fileFloor: 5,
      matchFloor: 5,
    });
    expect(hits.some((h) => h.file === "source-files.ts")).toBe(true);
    expect(() =>
      scanSourceMatches(helpers, /no such text anywhere\u0000/g, {
        fileFloor: 5,
        matchFloor: 1,
      }),
    ).toThrow(/below the stated floor/);
    expect(() =>
      scanSourceMatches(helpers, /export/, { fileFloor: 5, matchFloor: 1 }),
    ).toThrow(/g flag/);
  });
});
