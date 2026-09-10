/**
 * A module gate decides from the RECORD's map, never from "am I a delegate".
 *
 * Every surface that paints a module reads `user?.modules?.X`, and a run of
 * them used to widen that read with `inSharedRecord || …`. The prefix was
 * right when it was written: `GET /api/auth/me` published the ACTOR's module
 * map, so a delegate's own preferences would have closed a page in somebody
 * else's record. Since the map became the record's, masked to what the grant
 * opens, the same prefix fails open in the other direction — the navigation
 * correctly drops the entry while a typed URL still renders the page for a
 * record whose owner switched the module off, and the routes behind these
 * pages carry no module gate of their own, so the page works.
 *
 * A DISCOVERED set rather than a named one. The first version of this guard
 * froze the six files one sweep happened to find; three more were carrying the
 * identical expression at the time, and a named list is structurally unable to
 * say so. So the sweep walks every component under `src/app` and
 * `src/components`, and the property is about the SHAPE: no boolean `||` may
 * join `inSharedRecord` to a module read. The window the matcher searches
 * cannot cross a `;`, a `{` or a `}`, so it sees one expression at a time and
 * a delegate check elsewhere in the same file is none of its business.
 *
 * A structural check rather than a render, because the thing that regressed is
 * one `||`: reaching these pages in a unit test would mean standing up the
 * auth query, the router and the shell, and none of that is where the defect
 * lives.
 *
 * Its limit, stated: it holds the two spellings of the OR. A gate that widened
 * itself some other way — a ternary, a helper returning the delegate flag —
 * would pass. The non-vacuity floor below is what keeps a broken walker from
 * reading as a clean sweep.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { stripComments, walkSourceFiles } from "./helpers/source-files";

const ROOT = process.cwd();
/** Floors pinned below the real counts, so a broken walk throws. */
const ROOTS: ReadonlyArray<[string, number]> = [
  ["src/app", 100],
  ["src/components", 700],
];

/** The module read every gated surface makes. */
const MODULE_READ = "user?.modules?.";

/**
 * The two spellings of the widening, in one expression each.
 *
 * `[^;{}]*` is the whole point: it cannot cross a statement end or a block
 * boundary, so a file that reads the module map in one place and asks about
 * the delegate in another does not match.
 */
const WIDENED = [
  /inSharedRecord\s*\|\|[^;{}]*user\?\.modules\?\./,
  /user\?\.modules\?\.[^;{}]*\|\|\s*inSharedRecord/,
];

/** Every `.tsx` under the roots, with its comment-stripped source. */
function componentSources(): Array<{ file: string; source: string }> {
  const out: Array<{ file: string; source: string }> = [];
  for (const [root, floor] of ROOTS) {
    const files = walkSourceFiles(join(ROOT, root), {
      floor,
      extensions: [".tsx"],
    });
    for (const rel of files) {
      if (rel.includes("__tests__/")) continue;
      out.push({
        file: `${root}/${rel}`,
        source: stripComments(readFileSync(join(ROOT, root, rel), "utf8")),
      });
    }
  }
  return out;
}

describe("a module gate reads the record's map alone", () => {
  const sources = componentSources();
  const gated = sources.filter(({ source }) => source.includes(MODULE_READ));

  it("discovers a real set of module-gated surfaces", () => {
    // The empty-match trap: a walker that stopped walking, or a spelling of
    // the module read that moved, would make every assertion below vacuous.
    expect(sources.length, "no component was walked at all").toBeGreaterThan(
      500,
    );
    expect(
      gated.length,
      "no surface was found reading the module map",
    ).toBeGreaterThan(20);
    // Spot checks, so a sweep that found twenty of the wrong files still
    // fails: these are module-gated pages by construction.
    const files = new Set(gated.map((entry) => entry.file));
    for (const file of [
      "src/app/vaccinations/page.tsx",
      "src/app/labs/page.tsx",
      "src/app/mood/page-client.tsx",
      "src/components/documents/documents-view.tsx",
    ]) {
      expect(files, `${file} was not discovered`).toContain(file);
    }
  });

  it("finds no gate widened by the delegate flag", () => {
    const widened = gated
      .filter(({ source }) => WIDENED.some((pattern) => pattern.test(source)))
      .map(({ file }) => file);

    expect(
      widened,
      `these surfaces widen a module gate for a delegate; the record's masked map already answers for both cases:\n${widened
        .map((file) => `  ❌ ${file}`)
        .join("\n")}`,
    ).toEqual([]);
  });
});
