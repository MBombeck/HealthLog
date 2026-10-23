/**
 * Structural guard: a least-squares line is fitted in `lib/stats/linear-fit`.
 *
 * Six readers fitted one by hand, four with the determinant form
 * `n·Σxy − Σx·Σy` and two with centred sums, and two charts carried the same
 * function twice. The matcher flags either form of the slope outside the
 * implementation. Comments are stripped first; the planted cases prove the
 * matcher fires.
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
  "lib/stats/linear-fit.ts": "The implementation.",
};

const HAND_ROLLED_SLOPE =
  /\bn\s*\*\s*sum_?xy\s*-\s*sum_?x\s*\*\s*sum_?y\b|\bsxy\s*\/\s*sxx\b|\bsumXy\s*-\s*\(\s*sumX\s*\*\s*sumY\s*\)\s*\/\s*n\b/i;

describe("one least-squares line", () => {
  it("the matcher fires on a hand-rolled slope", () => {
    expect(
      HAND_ROLLED_SLOPE.test(
        "const slope = (n * sumXY - sumX * sumY) / denominator;",
      ),
    ).toBe(true);
    expect(HAND_ROLLED_SLOPE.test("const slope = sxy / sxx;")).toBe(true);
    expect(
      HAND_ROLLED_SLOPE.test("const sxy = sumXy - (sumX * sumY) / n;"),
    ).toBe(true);
    expect(HAND_ROLLED_SLOPE.test("const fit = linearFit(xs, ys);")).toBe(
      false,
    );
  });

  it("no file outside the implementation fits its own", () => {
    const files = walkSourceFiles(SRC, { floor: 3000 }).filter(
      (file) =>
        !file.startsWith("generated/") &&
        !file.includes("__tests__/") &&
        !/\.test\.tsx?$/.test(file),
    );
    const offenders = files.filter(
      (file) =>
        !(file in ALLOWED) &&
        HAND_ROLLED_SLOPE.test(stripComments(readSourceText(join(SRC, file)))),
    );
    expect(offenders).toEqual([]);
    // The six readers now call the implementation: a sweep that finds fewer
    // call sites read the wrong tree or lost one.
    const callers = files.filter((file) =>
      /\b(?:linearFit|fitFromSums|trendLineByTime)\s*\(/.test(
        stripComments(readSourceText(join(SRC, file))),
      ),
    );
    expect(callers.length).toBeGreaterThanOrEqual(7);
    // The implementation itself matches, so the sweep read real files.
    expect(
      HAND_ROLLED_SLOPE.test(
        stripComments(
          readSource(
            "src/lib/stats/linear-fit.ts",
            "export function linearFit",
          ),
        ),
      ),
    ).toBe(true);
  });
});
