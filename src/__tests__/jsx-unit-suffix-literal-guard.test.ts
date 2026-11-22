import { describe, expect, it } from "vitest";
import { join } from "node:path";

import {
  readSourceText,
  stripComments,
  walkSourceFiles,
} from "@/__tests__/helpers/source-files";

/**
 * GUARD: no unit letter glued to a value in JSX text.
 *
 * The medication compliance card labelled its range buttons `{r}T`, so every
 * locale read "7T / 30T / 90T" (the German abbreviation for days), screen
 * readers included. A letter written straight after an expression in JSX text
 * never passes through `t()`, so `i18n-call-site-coverage` cannot see it and
 * no locale can change it. A unit beside a number goes through a message
 * (`charts.daysNLabel`, `charts.daysNAria`) or a formatter.
 *
 * The matcher looks for `{expression}` followed by one to three letters and
 * then the end of the line or a closing tag: JSX text, not a template
 * literal (`${…}T` in an ISO date is code) and not an attribute.
 */

const SRC = join(process.cwd(), "src");

const UNIT_SUFFIX = /(?<!\$)\{[^{}\n`]+\}[A-Za-zÀ-ÿ]{1,3}(?=\s*(<|$))/gm;

describe("JSX text carries no hard-coded unit suffix", () => {
  it("the matcher finds the shape it is meant to find", () => {
    // Written, then checked against the shape it replaced: an empty sweep
    // must mean a clean tree, not a matcher that matches nothing.
    const sample = [
      "            >",
      "              {r}T",
      "            </Button>",
    ];
    expect(sample.join("\n").match(UNIT_SUFFIX)).toEqual(["{r}T"]);
    expect("<span>{days}d</span>".match(UNIT_SUFFIX)).toEqual(["{days}d"]);
    // Not JSX text: a template literal building an ISO timestamp.
    expect("`${nextDate}T${time}`".match(UNIT_SUFFIX)).toBeNull();
  });

  it("no component writes a unit letter after a value", () => {
    const files = walkSourceFiles(SRC, {
      floor: 1500,
      extensions: [".tsx"],
    }).filter((rel) => !rel.includes("__tests__/"));
    const offenders: string[] = [];
    for (const rel of files) {
      const source = stripComments(readSourceText(join(SRC, rel)), rel);
      for (const match of source.matchAll(UNIT_SUFFIX)) {
        const line = source.slice(0, match.index).split("\n").length;
        offenders.push(`${rel}:${line} ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
