import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * The code-side twin of `i18n-no-dot-separator.test.ts`: a string the code
 * composes itself (an aria-label `${action} — ${name}`, a page title, a
 * Coach prefill) carries no spaced em or en dash either. The bundles say
 * "Move up: Ramipril" and "No connection: changes can't be saved", so a
 * label put together in a component says it the same way.
 *
 * The matcher looks at string and template literals on one line, outside
 * comments: a quote or backtick, then text, a space, U+2014 or U+2013, a
 * space. A range written in code ("10–12", `${from}–${to}`) has no spaces
 * around its dash and is not matched. A template literal broken across lines
 * escapes the one-line matcher, which is this guard's known limit.
 */

const ROOT = join(__dirname, "..");
const DIRS = ["components", "app"].map((d) => join(ROOT, d));
const LITERAL = /(["'`])[^"'`]* [—–] [^"'`]*\1/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === "__tests__") continue;
      walk(path, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) {
      out.push(path);
    }
  }
  return out;
}

const isComment = (line: string) => /^\s*(\/\/|\*|\/\*|\{\/\*)/.test(line);

describe("composed UI strings carry no spaced dash", () => {
  const files = DIRS.flatMap((d) => walk(d));

  it("walks the component and app trees", () => {
    expect(files.length).toBeGreaterThan(500);
  });

  it("has no ' — ' or ' – ' inside a string or template literal", () => {
    const offenders: string[] = [];
    for (const file of files) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (isComment(line)) return;
          const code = line.replace(/\s\/\/\s.*$/, "");
          if (LITERAL.test(code)) {
            offenders.push(`${relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
          }
        });
    }
    expect(offenders).toEqual([]);
  });

  it("catches the pattern it is written for", () => {
    expect(LITERAL.test("aria-label={`${a} — ${b}`}")).toBe(true);
    expect(LITERAL.test('title: "About – HealthLog"')).toBe(true);
    expect(LITERAL.test("`${from}–${to}`")).toBe(false);
  });
});
