/**
 * Structural guard: every runtime skip in the e2e suite says why.
 *
 * A runtime `test.skip(condition, reason)` or `test.fixme(condition, reason)`
 * turns a test off without failing anything, and a skipped test reads like a
 * passing one in a CI summary. `delegated-writes.spec.ts` skipped every test on
 * every run that way: its condition was evaluated before the form it checked
 * for had painted. The reason string is what makes a skip reviewable, so every
 * conditional call must carry one, and a bare `test.skip()` (which cannot) is
 * refused outright.
 *
 * This is the per-call half. The per-file half, a spec whose every test
 * skipped in CI, is `scripts/check-e2e-skipped-specs.mjs`, run by the e2e
 * workflow's gate job over the Playwright JSON reports.
 *
 * The matcher reads the call's arguments with a small bracket-aware scanner
 * rather than a regex, because conditions span lines and reasons are
 * concatenated. Its limit: a skip reached through another name (an alias of
 * `test`, `testInfo.skip`) is not seen. The non-empty assertion below keeps the
 * matcher from going quietly green by matching nothing.
 */
import { globSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { stripComments } from "./helpers/source-files";

const E2E = join(process.cwd(), "e2e");

type SkipCall = { file: string; line: number; args: string[] };

function specFiles(): string[] {
  return globSync("**/*.spec.ts", { cwd: E2E })
    .map((p) => p.split(sep).join("/"))
    .sort();
}

/**
 * The top-level arguments of the call whose `(` sits at `open`, as trimmed
 * source text. Strings and template literals are skipped over whole, so a
 * comma or bracket inside a reason does not split it.
 */
function callArgs(src: string, open: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      for (i++; i < src.length && src[i] !== c; i++) {
        if (src[i] === "\\") i++;
      }
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) {
        const last = src.slice(start, i).trim();
        if (last) args.push(last);
        return args;
      }
    } else if (c === "," && depth === 1) {
      args.push(src.slice(start, i).trim());
      start = i + 1;
    }
  }
  throw new Error("unbalanced call");
}

function skipCalls(): SkipCall[] {
  const calls: SkipCall[] = [];
  for (const file of specFiles()) {
    const src = stripComments(readFileSync(join(E2E, file), "utf8"));
    for (const m of src.matchAll(/\btest\.(?:skip|fixme)\s*\(/g)) {
      const open = m.index + m[0].length - 1;
      calls.push({
        file,
        line: src.slice(0, m.index).split("\n").length,
        args: callArgs(src, open),
      });
    }
  }
  return calls;
}

/** A string literal, template literal, or a concatenation starting with one. */
const REASON = /^(["'`])(?!\1)[\s\S]+/;

/**
 * The declaration form, `test.skip("title", () => …)`, marks a test as
 * skipped at collection time rather than on a runtime condition; the first
 * argument is its title, not a condition.
 */
function isDeclaration(call: SkipCall): boolean {
  return /^["'`]/.test(call.args[0] ?? "") && call.args.length >= 2;
}

describe("e2e runtime skips carry a reason", () => {
  const calls = skipCalls();
  const conditional = calls.filter(
    (c) => c.args.length > 0 && !isDeclaration(c),
  );

  it("finds the conditional skips at all", () => {
    // The suite has many project-specific skips. If the matcher ever finds
    // none, it has stopped reading the specs, not the specs stopped skipping.
    expect(conditional.length).toBeGreaterThan(10);
  });

  it("every conditional skip names its reason", () => {
    const offenders = conditional
      .filter((c) => c.args.length < 2 || !REASON.test(c.args[1]!))
      .map((c) => `${c.file}:${c.line}`);
    expect(offenders).toEqual([]);
  });

  it("no spec skips unconditionally without a reason", () => {
    const bare = calls
      .filter((c) => c.args.length === 0)
      .map((c) => `${c.file}:${c.line}`);
    expect(bare).toEqual([]);
  });

  it("the delegated-writes journey no longer skips itself", () => {
    // It skipped every test on every run for as long as its guard stood; it
    // now fails loudly when the form it needs is missing.
    expect(calls.filter((c) => c.file === "delegated-writes.spec.ts")).toEqual(
      [],
    );
  });

  it("the scanner reads a multi-line call with a concatenated reason", () => {
    // The matcher's own positive control, on the shape the suite actually uses.
    const src = `test.skip(\n  a(b, c) !== "x, y",\n  "one, " +\n    "two",\n);`;
    expect(callArgs(src, src.indexOf("("))).toEqual([
      'a(b, c) !== "x, y"',
      '"one, " +\n    "two"',
    ]);
    expect(REASON.test('""')).toBe(false);
  });
});
