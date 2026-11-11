/**
 * A picker whose dropdown should be as wide as its field.
 *
 * Under Tailwind 4 the v3 shorthand `w-[--radix-popover-trigger-width]`
 * compiles to `width: --radix-popover-trigger-width`, which no browser
 * accepts, so the width silently fell back to the content's. The v4 form is
 * `w-(--radix-popover-trigger-width)`. And `PopoverContent` caps every
 * popover at `max-w-xs` (20 rem), shorter than a full-width field on most
 * phones, so the match needs `max-w-none` beside it.
 */
import { describe, expect, it } from "vitest";

import { productionSources, readSrc } from "@/__tests__/helpers/source-metrics";

const V3_VARIABLE = /(?<![\w-])[\w-]+-\[--[\w-]+\]/g;
const CLASS_STRING = /"[^"\n]*--radix-popover-trigger-width[^"\n]*"/g;

describe("popover trigger width", () => {
  const files = productionSources()
    .filter((rel) => rel.endsWith(".tsx"))
    .map((rel) => [rel, readSrc(rel)] as const);

  it("uses no Tailwind 3 variable shorthand", () => {
    const offenders = files.flatMap(([rel, text]) =>
      [...text.matchAll(V3_VARIABLE)].map((m) => `${rel}: ${m[0]}`),
    );
    expect(offenders).toEqual([]);
  });

  it("lifts the popover's width cap wherever it matches the trigger", () => {
    const strings = files.flatMap(([rel, text]) =>
      [...text.matchAll(CLASS_STRING)].map((m) => [rel, m[0]] as const),
    );
    expect(strings.length).toBeGreaterThanOrEqual(2);
    const capped = strings
      .filter(([, cls]) => !/\bmax-w-none\b/.test(cls))
      .map(([rel, cls]) => `${rel}: ${cls}`);
    expect(capped).toEqual([]);
  });
});
