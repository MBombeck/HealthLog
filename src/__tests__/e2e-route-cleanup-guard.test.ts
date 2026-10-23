/**
 * Structural guard on the E2E suite's route-cleanup boundary.
 *
 * A spec that arms `page.route(...)` in a `beforeEach` and never drops the
 * handler races its own teardown: the context closes, an in-flight handler
 * rejects, and Playwright reports a test that had already passed as failed.
 * `e2e/setup/test.ts` removes the possibility with an auto fixture, but only
 * for specs that take their `test` from there — a spec that imports straight
 * from `@playwright/test` silently opts out and looks identical in review.
 *
 * So the entry point is the invariant, and this file is what keeps it true.
 * It is a tripwire, not a proof: it shows nobody has changed the import
 * boundary without editing this file. That the fixture actually cleans up is
 * a runtime property, proven by the suite itself.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { stripComments, walkSourceFiles } from "./helpers/source-files";

const E2E = join(process.cwd(), "e2e");

/** The shared entry point, relative to `e2e/`. */
const ENTRY = "setup/test.ts";

/**
 * Files allowed to import `test` from `@playwright/test` directly, each with
 * the reason it has to.
 */
const DIRECT_IMPORT_ALLOWLIST: Record<string, string> = {
  // The entry point itself — it extends Playwright's base `test`, which it
  // cannot do without importing it.
  [ENTRY]: "defines the extended `test` every other file imports",
};

function e2eFiles(): string[] {
  return walkSourceFiles(E2E, { floor: 40, extensions: [".ts"] }).sort();
}

function read(rel: string): string {
  return readFileSync(join(E2E, rel), "utf8");
}

/**
 * Every `from "<module>"` import statement in a file, as
 * `{ module, specifiers }` — `specifiers` is the raw brace body, or `"*"` for
 * a namespace import.
 */
function imports(src: string): Array<{ module: string; specifiers: string }> {
  const found: Array<{ module: string; specifiers: string }> = [];
  for (const m of src.matchAll(
    /import\s+(type\s+)?\{([\s\S]*?)\}\s*from\s*"([^"]+)"/g,
  )) {
    // `import type { … }` imports no runtime binding at all.
    found.push({ module: m[3], specifiers: m[1] ? "" : m[2] });
  }
  for (const m of src.matchAll(/import\s+\*\s+as\s+\w+\s+from\s*"([^"]+)"/g)) {
    found.push({ module: m[1], specifiers: "*" });
  }
  return found;
}

/** Does this file import the runtime `test` binding from `module`? */
function importsTestFrom(src: string, module: string): boolean {
  return imports(src)
    .filter((i) => i.module === module)
    .some(
      (i) =>
        i.specifiers === "*" ||
        i.specifiers
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s && !s.startsWith("type "))
          .some((s) => /^test(\s+as\s+\w+)?$/.test(s)),
    );
}

describe("the E2E suite takes `test` from the shared entry point", () => {
  it("no file outside the allowlist imports `test` from @playwright/test", () => {
    const offenders = e2eFiles().filter(
      (rel) =>
        !(rel in DIRECT_IMPORT_ALLOWLIST) &&
        importsTestFrom(read(rel), "@playwright/test"),
    );

    expect(offenders).toEqual([]);
  });

  it("the allowlist names only files that exist and still need the exemption", () => {
    for (const rel of Object.keys(DIRECT_IMPORT_ALLOWLIST)) {
      expect(
        importsTestFrom(read(rel), "@playwright/test"),
        `${rel} is allowlisted but no longer imports \`test\` directly — drop the entry`,
      ).toBe(true);
    }
  });

  it("every spec imports `test` from the entry point", () => {
    const specs = e2eFiles().filter((rel) => rel.endsWith(".spec.ts"));
    // Sanity: the sweep found the suite, not an empty directory.
    expect(specs.length).toBeGreaterThan(40);

    const missing = specs.filter((rel) => {
      const src = read(rel);
      // Specs sit at `e2e/<name>.spec.ts`, so the entry resolves as
      // `./setup/test`. A nested spec would need a different prefix; none
      // exists, and this assertion is what would surface one.
      return !importsTestFrom(src, "./setup/test");
    });

    expect(missing).toEqual([]);
  });
});

describe("the entry point still cleans up", () => {
  const src = stripComments(read(ENTRY));

  it("registers the cleanup as an automatic fixture", () => {
    // `auto: true` is the whole point: a spec author cannot forget it and does
    // not have to declare it. Without the flag the fixture is dead code.
    expect(src).toMatch(/\{\s*auto:\s*true\s*\}/);
  });

  it("drops route handlers on both the page and the context", () => {
    expect(src).toMatch(/page\.unrouteAll\(\{\s*behavior:\s*"ignoreErrors"/);
    expect(src).toMatch(/context\.unrouteAll\(\{\s*behavior:\s*"ignoreErrors"/);
  });

  it("drops page event listeners", () => {
    expect(src).toMatch(/removeAllListeners\(/);
  });

  it("cleans up after the test body, not before it", () => {
    // `await use()` first, cleanup after — a fixture that cleaned up before
    // the test would unroute the handlers a `beforeEach` had just armed.
    const useAt = src.indexOf("await use()");
    const unrouteAt = src.indexOf("unrouteAll(");
    expect(useAt).toBeGreaterThan(-1);
    expect(unrouteAt).toBeGreaterThan(useAt);
  });

  it("exports both `test` and `expect`, so a spec needs one import", () => {
    expect(src).toMatch(/export const test\b/);
    expect(src).toMatch(/export \{ expect \}/);
  });
});
