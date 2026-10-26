/**
 * Structural guard: a provider client walks a paged collection through
 * `walkPages` (`src/lib/integrations/page-walk.ts`), never a loop of its own.
 *
 * Each hand-rolled loop ended at its page ceiling by returning what it had,
 * silently, and the backfill around it stamped the history complete. A
 * `while (pages < MAX)`, a `pageCount > N` break or a `do … while (next &&
 * pageCount < max)` in a provider directory is that class coming back.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { PROVIDER_DIRS } from "./helpers/provider-dirs";
import { stripComments, walkSourceFiles } from "./helpers/source-files";

const LIB = join(process.cwd(), "src", "lib");
/**
 * Page loops that stay outside `walkPages` on purpose, with how many matches
 * each file may hold and why. A file with more matches than its allowance has
 * grown a loop of its own and fails like any other.
 *
 * Google Health's list walk (`forEachDataPointPage`) is bounded by progress,
 * not by a cursor ceiling: it stops after `GOOGLE_HEALTH_NO_PROGRESS_PAGES`
 * pages in a row that reach no further back (the same page token handed out
 * again counts toward that, rather than ending the walk at once as
 * `walkPages` does), streams each page to the writer instead of collecting
 * the collection (a dense heart-rate history does not fit in the heap), stops
 * mid-walk on the backfill slice's budget and on a rate limit it cannot wait
 * out, passes over pages beyond the resume edge without charging them to its
 * ceiling, and keeps its place in the list for the next slice. Its truncation
 * reaches the backfill through the client outcome, and the backfill decides
 * from it with its own sliced verdict (continue, wait for a retry, stuck,
 * complete; `jobs/google-health-backfill.ts`), which `backfillVerdict`'s
 * three outcomes cannot carry.
 */
const EXCEPTIONS: Readonly<Record<string, { matches: number; why: string }>> = {
  "google-health/data-points.ts": {
    matches: 1,
    why: "progress-bounded streaming list walk with slice budget and resume (forEachDataPointPage)",
  },
};

/**
 * A page counter compared against a bound, in any of the shapes used. A
 * literal bound of 0 or 1 is a validity check (`page > 0`), not a ceiling.
 */
const PAGE_LOOP =
  /\b(?:pages?|pageCount|pagesRead|page)(?:\s*-\s*[A-Za-z_]\w*)?\s*(?:<|<=|>|>=)\s*(?:[A-Z_][A-Z0-9_]*|maxPages|[2-9]|[1-9]\d+)\b/g;

describe("provider clients walk pages through walkPages", () => {
  const files = walkSourceFiles(LIB, { floor: 1000 }).filter(
    (f) =>
      PROVIDER_DIRS.some((d) => f.startsWith(`${d}/`)) &&
      !f.includes("__tests__") &&
      !f.endsWith(".test.ts"),
  );
  const matches = (f: string) =>
    stripComments(readFileSync(join(LIB, f), "utf8")).match(PAGE_LOOP)
      ?.length ?? 0;

  it("walks the provider directories", () => {
    expect(files.length).toBeGreaterThanOrEqual(60);
    expect(PROVIDER_DIRS).toEqual(
      expect.arrayContaining(["strava", "whoop", "withings", "google-health"]),
    );
    for (const dir of PROVIDER_DIRS) {
      expect(
        files.some((f) => f.startsWith(`${dir}/`)),
        dir,
      ).toBe(true);
    }
  });

  it("finds no page loop of their own beyond the exceptions", () => {
    const over = files
      .map((f) => ({ f, n: matches(f), allowed: EXCEPTIONS[f]?.matches ?? 0 }))
      .filter(({ n, allowed }) => n > allowed)
      .map(({ f, n }) => `${f}: ${n}`);
    expect(over).toEqual([]);
  });

  it("keeps the exceptions honest", () => {
    const stale = Object.entries(EXCEPTIONS)
      .filter(([f, { matches: allowed }]) => matches(f) !== allowed)
      .map(([f]) => f);
    expect(stale).toEqual([]);
  });

  it("catches the shapes the loops used", () => {
    for (const planted of [
      "while (pages < WORKOUT_MAX_PAGES) {",
      "if (pageCount > 1000) break;",
      "} while (nextToken && pageCount < maxPages);",
      "} while (pageToken && pageCount - skipped < maxPages);",
      "for (let page = 1; page <= maxPages; page++) {",
    ]) {
      expect(planted.match(PAGE_LOOP), planted).not.toBeNull();
    }
    for (const fine of [
      "const walk = await walkPages(label, 12, f);",
      "r.page > 0 ? r.page : undefined",
    ]) {
      expect(fine.match(PAGE_LOOP), fine).toBeNull();
    }
  });
});
