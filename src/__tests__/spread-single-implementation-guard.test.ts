/**
 * Structural guard: a standard deviation is computed in `lib/stats/spread`,
 * with its kind named at the call site.
 *
 * About a dozen hand-rolled spreads each picked population (÷ n) or sample
 * (÷ n − 1) without saying so, and the two surfaces a person compares picked
 * differently: the series API reported the population SD of a blood-pressure
 * series, the MCP and AI payload the sample SD of the same readings, about
 * 22 % apart at three readings. The reading spread both report is now
 * `READING_SPREAD`.
 *
 * The matcher flags a squared deviation from a mean in a file that also takes
 * a square root. The files below compute one for a test statistic or a fit,
 * never as a reported spread, and say so. The doctor report's glucose panel
 * composes its SD from per-bucket sums of squares (sample, the same rule as
 * `glucoseSD`) and is out of the matcher's reach by shape. Comments are
 * stripped first; the planted case proves the matcher fires.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  readSource,
  readSourceText,
  stripComments,
  walkSourceFiles,
} from "./helpers/source-files";

const SRC = join(process.cwd(), "src");

const ALLOWED: Record<string, string> = {
  "lib/stats/spread.ts": "The implementation.",
  "lib/insights/correlations.ts":
    "The correlation engine's centred sums and the Welch t-test variances.",
  "lib/insights/mood-tag-influence.ts": "Welch t-test variances.",
  "lib/insights/mood-pattern-cards.ts": "A pooled variance for a t statistic.",
  "lib/stats/segmented-regression.ts":
    "The total sum of squares behind R² and the HAC standard errors of a segmented fit; neither is reported as a spread.",
  "lib/insights/derived/trajectory.ts":
    "The residual standard error of a regression fit (÷ n − 2).",
  "lib/insights/derived/sleep-score.ts":
    "A circular SD of the sleep midpoint around its circular mean, the input of the consistency score; `spread` has no circular distance, and the score is never shown as a spread.",
};

/**
 * A squared deviation: `(x - m) ** 2`, `(x - m) * (x - m)`, or a two-argument
 * distance squared, `dist(x, m) ** 2` (a circular or otherwise custom
 * deviation is still a hand-rolled spread).
 */
const SQUARED_DEVIATION =
  /\(\s*[\w.[\]]+\s*-\s*[\w.[\]]+\s*\)\s*\*\*\s*2|\(\s*([\w.[\]]+)\s*-\s*([\w.[\]]+)\s*\)\s*\*\s*\(\s*\1\s*-\s*\2\s*\)|\b[A-Za-z_]\w*\s*\(\s*[\w.[\]]+\s*,\s*[\w.[\]]+\s*\)\s*\*\*\s*2/;

function computesSpread(code: string): boolean {
  return SQUARED_DEVIATION.test(code) && code.includes("Math.sqrt(");
}

function read(file: string): string {
  return stripComments(readSourceText(join(SRC, file)));
}

describe("one standard deviation", () => {
  it("the matcher fires on a hand-rolled spread", () => {
    expect(
      computesSpread(
        "const v = xs.reduce((s, x) => s + (x - m) ** 2, 0) / n; Math.sqrt(v);",
      ),
    ).toBe(true);
    expect(
      computesSpread("acc += (v - mean) * (v - mean); Math.sqrt(acc / n);"),
    ).toBe(true);
    expect(
      computesSpread(
        "xs.reduce((s, v) => s + circularMinuteDistance(v, mean) ** 2, 0); Math.sqrt(x);",
      ),
    ).toBe(true);
  });

  it("no file outside the list computes its own", () => {
    const offenders = walkSourceFiles(SRC, { floor: 3000 })
      .filter(
        (file) =>
          !file.startsWith("generated/") &&
          !file.includes("__tests__/") &&
          !/\.test\.tsx?$/.test(file),
      )
      .filter((file) => computesSpread(read(file)) && !(file in ALLOWED));
    expect(offenders).toEqual([]);
  });

  it("the series API and the AI and MCP payload report the same spread", () => {
    expect(
      stripComments(
        readSource("src/lib/measurements/series/kinds.ts", "READING_SPREAD"),
      ),
    ).toMatch(/standardDeviation\(\s*values,\s*READING_SPREAD\s*\)/);
    const features = stripComments(
      readSource("src/lib/insights/features.ts", "READING_SPREAD"),
    );
    expect(
      features.match(/roundedSpread\(\s*vals,\s*READING_SPREAD\s*\)/g),
    ).toHaveLength(2);
  });
});
