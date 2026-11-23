/**
 * The window's edges are read in one place.
 *
 * `globals.css` declares the shell's edge tokens once (`--safe-area-*`,
 * `--bottom-bar-height`, `--chrome-bottom`, `--floating-action-*`,
 * `--chrome-bottom-surface`; ui-standards.md §9). Everything else reads those
 * properties. Two things this holds:
 *
 *   - No file outside the token block reads `env(safe-area-inset-*)`. A
 *     second reading is a second answer: the shell, the bottom bar and the
 *     Coach button each took the inset their own way, and an inset a test
 *     sets through the property never reached the ones that bypassed it.
 *   - Nothing positions itself above the bottom bar by a number of its own
 *     (`calc(4rem + inset)`, `inset + 5rem`): the bar's height, the floating
 *     button's line and the page's clearance come from the tokens, so one
 *     change moves all of them together.
 *
 * Comments are stripped first, so prose about the old spellings cannot trip
 * the guard, and each check asserts it saw the files it claims to have swept.
 */
import { describe, expect, it } from "vitest";

import {
  readSource,
  readSourceFolder,
  stripComments,
} from "@/__tests__/helpers/source-files";

const ENV_INSET = /env\(\s*safe-area-inset-(?:top|right|bottom|left)\b/g;
/** The same, for a yes-or-no test (a global pattern carries state). */
const READS_ENV_INSET = new RegExp(ENV_INSET.source);

/**
 * The one file outside globals.css allowed to read `env()` itself: the error
 * boundary that replaces the root layout, where the stylesheet declaring the
 * tokens is not on the page.
 */
const ENV_ALLOWED = new Set(["app/global-error.tsx"]);

/**
 * A length of 4rem or more added to the home-indicator inset, either way
 * round: the shape of an offset above the bottom bar spelled by hand. Smaller
 * paddings over the inset (a sheet's own 1rem) are not offsets over the bar.
 */
const BAR_OFFSET_BY_HAND = new RegExp(
  [
    String.raw`(?<![\d.])(?:[4-9]|\d{2,})(?:\.\d+)?rem\s*\+\s*(?:var\(--safe-area-bottom\)|env\(\s*safe-area-inset-bottom)`,
    String.raw`(?:var\(--safe-area-bottom\)|env\(\s*safe-area-inset-bottom[^)]*\))\s*\+\s*(?:[4-9]|\d{2,})(?:\.\d+)?rem`,
  ].join("|"),
);

function sourceFiles(): Array<[string, string]> {
  return readSourceFolder("src", {
    floor: 1500,
    extensions: [".ts", ".tsx", ".css"],
    include: (rel) =>
      !rel.startsWith("generated/") && !rel.includes("__tests__/"),
  }).map(([rel, text]) => [rel, stripComments(text, rel)]);
}

describe("the shell's edge tokens", () => {
  const css = stripComments(
    readSource("src/app/globals.css", "--chrome-bottom-surface"),
    "globals.css",
  );
  const block = (() => {
    const start = css.indexOf(":root {\n    --safe-area-top:");
    expect(start).toBeGreaterThan(-1);
    return css.slice(start, css.indexOf("\n  }\n", start));
  })();

  it("are declared together, each inset read from env() exactly once", () => {
    for (const side of ["top", "right", "bottom", "left"]) {
      expect(block).toMatch(
        new RegExp(
          String.raw`--safe-area-${side}:\s*env\(safe-area-inset-${side},\s*0px\);`,
        ),
      );
    }
    for (const token of [
      "--bottom-bar-height",
      "--chrome-bottom",
      "--floating-action-size",
      "--floating-action-gap",
      "--floating-action-bottom",
      "--floating-action-clearance",
      "--chrome-bottom-surface",
    ]) {
      expect(block).toContain(`${token}:`);
    }
    expect(css.match(ENV_INSET)).toHaveLength(4);
    expect(block.match(ENV_INSET)).toHaveLength(4);
  });

  it("no other file reads env(safe-area-inset-*)", () => {
    const files = sourceFiles();
    const readers = files
      .filter(([rel]) => rel !== "app/globals.css" && !ENV_ALLOWED.has(rel))
      .filter(([, text]) => READS_ENV_INSET.test(text))
      .map(([rel]) => rel);
    expect(readers).toEqual([]);
    // The allowance is still needed: the boundary still reads env() itself.
    for (const rel of ENV_ALLOWED) {
      const text = files.find(([path]) => path === rel)?.[1] ?? "";
      expect(text).toMatch(READS_ENV_INSET);
    }
  });

  it("nothing spells an offset above the bottom bar by hand", () => {
    const offenders = sourceFiles()
      .filter(([, text]) => BAR_OFFSET_BY_HAND.test(text))
      .map(([rel]) => rel);
    expect(offenders).toEqual([]);
  });

  it("the matcher finds the spellings it exists to stop", () => {
    for (const sample of [
      "bottom-[calc(var(--safe-area-bottom)+5rem)]",
      "pb-[calc(4rem+var(--safe-area-bottom))]",
      "calc(4rem + env(safe-area-inset-bottom, 0px) + 0.75rem)",
      "bottom-[calc(env(safe-area-inset-bottom,0px)+5rem)]",
    ]) {
      expect(sample).toMatch(BAR_OFFSET_BY_HAND);
    }
    for (const sample of [
      "pb-[calc(var(--safe-area-bottom)+1rem)]",
      "pb-[calc(0.75rem+var(--safe-area-bottom))]",
      "bottom-[calc(var(--safe-area-bottom)+0.5rem)]",
    ]) {
      expect(sample).not.toMatch(BAR_OFFSET_BY_HAND);
    }
    for (const sample of [
      "pt-[env(safe-area-inset-top)]",
      'padding: "calc(env(safe-area-inset-top, 0px) + 24px)"',
    ]) {
      expect(sample).toMatch(READS_ENV_INSET);
    }
  });
});
