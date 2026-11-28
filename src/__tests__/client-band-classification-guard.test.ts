/**
 * No client component places a value in a target band.
 *
 * The bands are resolved on the server (`targetBands` on the dashboard
 * snapshot), and so is where a value sits in them: the dashboard tiles'
 * comparison lines take their colour from `tiles.comparison`
 * (`src/lib/dashboard/tile-comparison.ts`), the same rule tile attention
 * reads. The web used to run its own classifier over the served ranges
 * (`getRangeTone`), which is a client recomputing a resolved value: the
 * native app would have had to mirror it, and the two copies drift.
 *
 * The rule here: no file under `src/components` compares anything with a
 * band bound (`greenMin`, `greenMax`, `orangeMin`, `orangeMax` read off an
 * object), and none imports the server's band rule. Printing a bound (the
 * colour-legend hint) or converting it into the display unit stays allowed;
 * those carry no comparison operator.
 *
 * The deviation line under a ranged tile ("Above target range") is worded on
 * the server too (`tiles.comparison[id].line`), so no component names its
 * message keys (`dashboard.tileComparison.*`): a client that builds the line
 * itself would decide on its own when a tile is out of range.
 *
 * {@link ALLOWED} names the one comparison that is not a classification of a
 * reading, with its reason and its count, so the matcher is proven to find
 * what it is looking for and a new comparison in that file still fails.
 *
 * Limit, stated: it reads text, not types. A bound destructured into a bare
 * local (`const { greenMin } = range`) and compared afterwards slips past.
 */
import { describe, expect, it } from "vitest";

import { scanSourceMatches, walkSourceFiles } from "./helpers/source-files";
import { readSourceText } from "./helpers/source-files";

const ROOT = "src/components";

const BOUND = String.raw`\.(?:greenMin|greenMax|orangeMin|orangeMax)\b`;
/**
 * A relational operator on either side of a bound read: `x >= range.greenMin`
 * or `range.greenMax < x`. An arrow (`=>`) and a JSX tag are not operators.
 */
const COMPARISON = new RegExp(
  String.raw`(?<![=\-<>])[<>]=?\s*[\w.?!()\[\]]*` +
    BOUND +
    "|" +
    BOUND +
    String.raw`(?:\s*[*/+\-]\s*[\d.]+)?\s*[<>]=?(?![=>])`,
  "g",
);

const SERVER_RULE_IMPORT =
  /from\s+["']@\/lib\/(?:targets\/consistency|dashboard\/tile-comparison)["']/g;

/** The server-only keys of the tile deviation line. */
const LINE_KEYS = /tileComparison\.(?:above|below)\b/;

/** Comparisons that are not a reading placed in a band, per file. */
const ALLOWED: Record<string, { count: number; reason: string }> = {
  "settings/thresholds-editor-section.tsx": {
    count: 2,
    reason:
      "Warns that a target being typed lies far outside the default band (min below 70 % of greenMin, max above 130 % of greenMax); it judges the person's input, not a reading.",
  },
};

const inScope = (rel: string) =>
  !rel.includes("__tests__/") && !/\.test\.tsx?$/.test(rel);

describe("client components never classify a value against a target band", () => {
  it("compares nothing with a band bound outside the allowlist", () => {
    const matches = scanSourceMatches(ROOT, COMPARISON, {
      fileFloor: 900,
      // The allowlisted comparisons, so an empty match set cannot pass.
      matchFloor: 2,
      include: inScope,
      stripComments: true,
    });
    const perFile = new Map<string, number>();
    for (const m of matches)
      perFile.set(m.file, (perFile.get(m.file) ?? 0) + 1);

    const unexpected = matches.filter(
      (m) => (ALLOWED[m.file]?.count ?? 0) < (perFile.get(m.file) ?? 0),
    );
    expect(
      unexpected.map((m) => `${ROOT}/${m.file}:${m.line} ${m.text}`),
      "Render the tone the server serves (tiles.comparison) instead of placing a value in targetBands on the client",
    ).toEqual([]);

    for (const [file, { count }] of Object.entries(ALLOWED)) {
      expect(perFile.get(file) ?? 0, `${file} allowlist count`).toBe(count);
    }
  });

  it("words no deviation line of its own", () => {
    const files = walkSourceFiles(ROOT, { floor: 900 }).filter(inScope);
    const builders = files.filter((rel) =>
      LINE_KEYS.test(readSourceText(`${ROOT}/${rel}`)),
    );
    expect(
      builders,
      "Show tiles.comparison[id].line as served instead of wording it on the client",
    ).toEqual([]);
  });

  it("imports no band rule of the server", () => {
    const files = walkSourceFiles(ROOT, { floor: 900 }).filter(inScope);
    const importers = files.filter((rel) => {
      const text = readSourceText(`${ROOT}/${rel}`);
      // A type-only import names the served shape and runs no rule.
      return [...text.matchAll(SERVER_RULE_IMPORT)].some(
        (m) =>
          !/import\s+type\b[^;]*$/.test(
            text.slice(0, m.index).split(";").pop()!,
          ),
      );
    });
    expect(importers).toEqual([]);
  });
});
