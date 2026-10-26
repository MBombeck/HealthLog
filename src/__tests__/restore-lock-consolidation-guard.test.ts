/**
 * Every day transaction of the consolidation family holds the account
 * against a restore before it touches a reading (`restore-lock.ts`).
 *
 * The passes built on `runConsolidation` fold an account a day at a time, and
 * each day's transaction takes row locks on the account's readings. A restore
 * deletes all of them in one statement. Without a common first lock the two
 * take the same rows in different orders and deadlock (#1031, pinned end to
 * end by `tests/integration/restore-consolidation-deadlock.test.ts` for the
 * step consolidation). This guard extends the rule to every pass on the same
 * base, present and future: each file that calls `runConsolidation` must open
 * every transaction it starts with `holdAccountAgainstRestore(tx, …)`.
 *
 * The matcher is whitespace-tolerant and the file and transaction counts are
 * asserted to be non-zero, so a pattern that matches nothing fails instead of
 * passing.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";
import { stripComments } from "./helpers/source-files";

const ROOT = join(__dirname, "..", "lib");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === "__tests__") continue;
      out.push(...sourceFiles(path));
    } else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) {
      out.push(path);
    }
  }
  return out;
}

/** The text of a file with its comments blanked, so prose cannot match. */
function code(path: string): string {
  return stripComments(readFileSync(path, "utf8"), path);
}

const passes = sourceFiles(ROOT).filter((path) =>
  /\bawait\s+runConsolidation\b/.test(code(path)),
);

describe("consolidation passes hold the account against a restore", () => {
  it("finds the passes", () => {
    // Step, mean, per-sample cumulative, dense intraday retention.
    expect(passes.length).toBeGreaterThanOrEqual(4);
  });

  it.each(passes.map((path) => [relative(ROOT, path), path]))(
    "%s opens every transaction with holdAccountAgainstRestore",
    (_label, path) => {
      const text = code(path);
      const opened = [
        ...text.matchAll(
          /\$transaction\(\s*async\s*\(\s*(\w+)\s*\)\s*=>\s*\{/g,
        ),
      ];
      expect(opened.length).toBeGreaterThan(0);
      for (const match of opened) {
        const tx = match[1];
        const after = text.slice(match.index! + match[0].length).trimStart();
        expect(after.startsWith(`await holdAccountAgainstRestore(${tx},`)).toBe(
          true,
        );
      }
    },
  );
});
