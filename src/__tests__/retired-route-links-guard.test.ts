/**
 * Links point at a route that renders, not at a retired one that only
 * redirects: every hop through a redirect is a round trip on a phone, and
 * the redirect stubs exist for old bookmarks, not for the app's own links.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");

/** Retired route → where it redirects. */
const RETIRED: Record<string, string> = {
  "/medications/new": "/medications?new=1",
};

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "__tests__" || name === "generated") return [];
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) return walk(abs);
    return /\.tsx?$/.test(name) ? [abs] : [];
  });
}

describe("no link targets a retired route", () => {
  const files = walk(join(ROOT, "src"));

  it("scans the source tree", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it.each(Object.entries(RETIRED))("%s is linked as %s", (route) => {
    const pattern = new RegExp(
      `(?:href|push|replace)[=(]\\s*\\{?\\s*["'\`]${route.replace(/\//g, "\\/")}["'\`?#]`,
    );
    const offenders = files
      .filter((file) => pattern.test(readFileSync(file, "utf8")))
      .map((file) => relative(ROOT, file));
    expect(offenders).toEqual([]);
  });
});
