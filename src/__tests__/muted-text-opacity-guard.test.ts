import { describe, it, expect } from "vitest";

import { readSourceFolder } from "./helpers/source-files";

/**
 * UI standards §3: muted text takes no further alpha. `text-muted-foreground`
 * is already the de-emphasis tier, tuned to AA in both themes; an `opacity-*`
 * on the same node drops it below the floor (`opacity-30` on muted text is
 * about 1.6:1) and makes a third tier the system does not have. The trend
 * slot of the dashboard and insights tiles printed a muted dash at
 * `opacity-30` beside every value without a trend, and read as a second,
 * unexplained value.
 *
 * The matcher looks at one class literal at a time: `text-muted-foreground`
 * and an unprefixed `opacity-N` in the same string. A state variant
 * (`disabled:opacity-50`, `group-hover:opacity-100`) is not matched; those
 * belong to the disabled look and to hover reveals, not to a text tier.
 */

const CLASS_LITERAL = /(["'`])([^"'`]*)\1/g;
const MUTED = /(^|\s)text-muted-foreground(\s|$)/;
const BARE_OPACITY = /(^|\s)opacity-\d+(\s|$)/;

/** File -> why. Empty by intent apart from the disabled look. */
const ALLOWED: Record<string, string> = {
  "components/ui/calendar.tsx":
    "a disabled day: the §3 disabled look, opacity on the whole cell",
};

function mutedOpacityLiterals(source: string): string[] {
  const hits: string[] = [];
  for (const match of source.matchAll(CLASS_LITERAL)) {
    const cls = match[2];
    if (MUTED.test(cls) && BARE_OPACITY.test(cls)) hits.push(cls);
  }
  return hits;
}

describe("muted text carries no opacity", () => {
  const isSource = (rel: string) =>
    !rel.includes("__tests__/") && !rel.includes(".test.");
  const files = [
    ...readSourceFolder("src/components", {
      floor: 500,
      include: isSource,
    }).map(([rel, text]) => [`components/${rel}`, text] as const),
    ...readSourceFolder("src/app", { floor: 100, include: isSource }).map(
      ([rel, text]) => [`app/${rel}`, text] as const,
    ),
  ];

  it("has no text-muted-foreground with a bare opacity-N", () => {
    const offenders: string[] = [];
    for (const [rel, text] of files) {
      if (rel in ALLOWED) continue;
      for (const cls of mutedOpacityLiterals(text)) {
        offenders.push(`${rel}: "${cls}"`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("matches the shape it is written for and not the state variants", () => {
    expect(
      mutedOpacityLiterals(
        '<span className="text-muted-foreground text-xs opacity-30">',
      ),
    ).toHaveLength(1);
    expect(
      mutedOpacityLiterals('cn("text-muted-foreground disabled:opacity-50")'),
    ).toHaveLength(0);
    expect(
      mutedOpacityLiterals('"text-muted-foreground group-hover:opacity-100"'),
    ).toHaveLength(0);
  });
});
