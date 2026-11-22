/**
 * No wide event carries how many health records a person has in a given
 * state: doses due, check-ups due, symptoms that followed a dose. Those
 * numbers are health data, and the wide event is a log that leaves the
 * process (`transports.ts`, GlitchTip). An operational figure (a page size,
 * a batch count, a skipped-row tally) is fine; a count of a person's doses
 * or symptoms in a clinical state is not.
 *
 * The guard walks every `meta: { ... }` literal under `src/app` and
 * `src/lib` and refuses a key that names such a count. Its limit: it reads
 * literal keys only, so a key spelled outside the listed nouns and states,
 * or built at run time, slips past it. The matcher asserts a non-zero key
 * count, so a parser that stops matching fails instead of passing on
 * nothing.
 */
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readSourceText, walkSourceFiles } from "./helpers/source-files";

const SRC = join(process.cwd(), "src");

const NOUNS = "doses?|checkups?|seizures?|symptoms?|intakes?|readings?";
const STATES = "due|taken|missed|skipped|overdue|offsets";
const FORBIDDEN = [
  new RegExp(`^(?:${NOUNS})_(?:${STATES})$`, "i"),
  new RegExp(`^(?:${NOUNS})(?:Due|Taken|Missed|Skipped|Overdue|Offsets)$`),
];

/** Every non-test source file under `src/app` and `src/lib`. */
function sourceFiles(): string[] {
  return walkSourceFiles(SRC, { floor: 1500 }).filter(
    (rel) =>
      (rel.startsWith("app/") || rel.startsWith("lib/")) &&
      !rel.includes("/__tests__/") &&
      !rel.startsWith("generated/") &&
      !/\.test\.tsx?$/.test(rel),
  );
}

/** The top-level keys of every `meta: { ... }` literal in a source text. */
function metaKeys(source: string): string[] {
  const keys: string[] = [];
  const opener = /\bmeta:\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(source)) !== null) {
    let depth = 1;
    let i = match.index + match[0].length;
    let segment = "";
    for (; i < source.length && depth > 0; i += 1) {
      const ch = source[i];
      if (ch === "{" || ch === "(" || ch === "[") depth += 1;
      else if (ch === "}" || ch === ")" || ch === "]") depth -= 1;
      if (depth === 1 || (depth === 0 && ch === "}")) {
        if (ch === "," || depth === 0) {
          const key = /^\s*(?:"([^"]+)"|([A-Za-z_$][\w$]*))\s*[:,]?/.exec(
            segment,
          );
          if (key) keys.push(key[1] ?? key[2]);
          segment = "";
        } else segment += ch;
      }
    }
  }
  return keys;
}

describe("wide-event health counts", () => {
  it("reads the keys of a meta literal, shorthand and nested values included", () => {
    expect(
      metaKeys(
        'annotate({ meta: { count: rows.length, nested: { a: 1 }, limit, "x.y": f(a, b) } });',
      ),
    ).toEqual(["count", "nested", "limit", "x.y"]);
  });

  it("refuses the shapes it is meant to refuse", () => {
    for (const key of [
      "doses_due",
      "checkups_due",
      "dose_offsets",
      "dosesDue",
    ]) {
      expect(FORBIDDEN.some((re) => re.test(key))).toBe(true);
    }
    for (const key of ["count", "remote_due", "doses_unlinked", "hasDue"]) {
      expect(FORBIDDEN.some((re) => re.test(key))).toBe(false);
    }
  });

  it("finds no health count in any wide-event meta", () => {
    let total = 0;
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const keys = metaKeys(readSourceText(join(SRC, file)));
      total += keys.length;
      for (const key of keys) {
        if (FORBIDDEN.some((re) => re.test(key))) {
          offenders.push(`${file}: ${key}`);
        }
      }
    }
    // The walk must see the meta literals it is checking.
    expect(total).toBeGreaterThan(500);
    expect(offenders).toEqual([]);
  });
});
