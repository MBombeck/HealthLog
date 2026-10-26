/**
 * The request guards have one public entry.
 *
 * `requireAuth`, the record modes, the cookie-only helpers and the step-up
 * gates live in `src/lib/auth/guards/`, one module per family, and
 * `src/lib/api-handler.ts` re-exports them beside `apiHandler`. Routes, jobs
 * and libraries import them from there. The guard modules import each other.
 * Nothing else reaches into the folder.
 *
 * One entry keeps the structural guards that freeze the auth surface honest:
 * they match an import of `@/lib/api-handler` and follow the local name to its
 * calls (`step-up-elevation-guard`, `recent-proof-surface-guard`,
 * `sharing-surface-guard`). A route that imported `requireMfaManagementAuth`
 * from its guard module directly would be invisible to all of them.
 */
import { dirname, join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

import { AUTH_GUARDS_DIR, authGuardModules } from "./helpers/auth-guards";
import {
  productionSources,
  readSrc,
  testSources,
} from "./helpers/source-metrics";

const SRC = join(process.cwd(), "src");
const GUARDS = "lib/auth/guards/";

/** The first-party module a specifier names, relative to `src/`, or null. */
function target(specifier: string, from: string): string | null {
  if (specifier.startsWith("@/")) return specifier.slice(2);
  if (specifier.startsWith(".")) {
    return relative(SRC, join(SRC, dirname(from), specifier))
      .split(sep)
      .join("/");
  }
  return null;
}

/**
 * Every module specifier in a file: static imports and re-exports, type-only
 * ones included (a type import is still a reach into the folder), and
 * dynamic `import("…")` / `vi.mock("…")` with a literal.
 */
const SPECIFIER =
  /\bfrom\s*["']([^"']+)["']|\b(?:import|mock|doMock)\(\s*["']([^"']+)["']/g;

/** Files that import, re-export or mock anything in the guard folder. */
function importersOfGuards(files: readonly string[]): string[] {
  return files.filter((rel) => {
    const text = readSrc(rel);
    if (!text.includes("guards")) return false;
    return [...text.matchAll(SPECIFIER)].some((m) =>
      (target(m[1] ?? m[2], rel) ?? "").startsWith(GUARDS),
    );
  });
}

describe("the auth guards' public entry", () => {
  it("is the only module outside the folder that imports a guard module", () => {
    const outside = importersOfGuards(productionSources()).filter(
      (rel) => !rel.startsWith(GUARDS),
    );
    // Non-zero proof: the entry itself must be found, or the matcher is blind.
    expect(outside.length).toBeGreaterThan(0);
    expect(outside).toEqual(["lib/api-handler.ts"]);
  });

  it("is not bypassed by tests either", () => {
    // Tests import the guards the way routes do, so a mock of
    // `@/lib/api-handler` stays the one seam they replace.
    expect(importersOfGuards(testSources())).toEqual([]);
  });

  it("covers a folder that is still there", () => {
    expect(authGuardModules().length).toBeGreaterThanOrEqual(10);
    expect(AUTH_GUARDS_DIR).toBe(`src/${GUARDS.slice(0, -1)}`);
  });
});
