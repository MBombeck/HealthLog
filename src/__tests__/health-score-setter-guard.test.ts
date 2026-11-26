/**
 * Since 1.50 the health score's band follows its number, so a green 79 can
 * sit over a red blood pressure. The pillar the band leaves unsaid is named
 * beside it (`bandSetter`). This guard holds the class, not one surface:
 * every file that puts the health score's band into words, or draws the
 * health score's ring, also reads the setter. A file that matches one of the
 * patterns below and never mentions it would say "steady" or paint an
 * unqualified green where a pillar is red.
 */
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readSourceText, scanSourceMatches } from "./helpers/source-files";

const SRC = join(__dirname, "..");

/** Where the health score's band becomes a word, a sentence or a ring. */
const WORDS_THE_BAND = [
  // The morning push's band sentence ("Looking steady today.").
  /daily\.push\.band\./g,
  // The health score's band word or band sentence.
  /bandWord\("health"|scoreBandWordKey\("health"|insights\.healthScore\.band\./g,
  // The evidence handed to the arrival line's model.
  /Health score: \$\{/g,
  // The Today ring drawn from the digest's score.
  /band=\{[^}]*score\.band as ScoreBand/g,
];

/** What reading the setter looks like in a file. */
const READS_SETTER = /bandSetter|healthScoreSetter/;

const include = (rel: string) =>
  !rel.includes("__tests__/") &&
  !rel.startsWith("generated/") &&
  !rel.startsWith("lib/openapi/");

describe("the health score's band is never said without its weakest pillar", () => {
  const matches = WORDS_THE_BAND.flatMap((pattern) =>
    scanSourceMatches(SRC, pattern, {
      fileFloor: 500,
      matchFloor: 1,
      include,
    }),
  );
  const files = [...new Set(matches.map((m) => m.file))].sort();

  it("finds the surfaces it guards", () => {
    // The push, the evidence, the Insights tile and panel, the morning
    // block and the Today hero. Fewer means a matcher went blind.
    expect(files.length).toBeGreaterThanOrEqual(6);
  });

  it.each(files)("%s reads the setter", (file) => {
    expect(READS_SETTER.test(readSourceText(join(SRC, file)))).toBe(true);
  });
});
