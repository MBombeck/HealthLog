import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { scanSourceMatches } from "./helpers/source-files";

/**
 * One source for the grain a chart draws its range tab at.
 *
 * The 90-day tab drew daily points for months because each chart chose its
 * grain from the data's span on its own, through the span ladder
 * `pickBucket`, and a 90-day window never spans more than 90 days. The grain
 * is now the tab's (`pickRangeBucket` in `src/lib/charts/range-grain.ts`),
 * and the span ladder is called only there and inside the bucketer itself,
 * whose automatic mode is the coach table's. A chart that calls the ladder
 * directly brings the class back, so it fails here.
 */
const SRC = join(process.cwd(), "src");
const ALLOWED = new Set([
  "lib/charts/bucket-time-series.ts",
  "lib/charts/range-grain.ts",
]);

describe("range grain source guard", () => {
  it("no chart calls the span ladder outside the grain module", () => {
    const hits = scanSourceMatches(SRC, /\bpickBucket\s*\(/g, {
      fileFloor: 500,
      // The definition and the two sanctioned calls, so a matcher that
      // finds nothing fails.
      matchFloor: 3,
      stripComments: true,
      include: (rel) =>
        !rel.startsWith("generated/") && !rel.includes("__tests__/"),
    });
    expect(hits.filter((hit) => ALLOWED.has(hit.file))).toHaveLength(3);
    expect(
      hits
        .filter((hit) => !ALLOWED.has(hit.file))
        .map((hit) => `${hit.file}:${hit.line}`),
    ).toEqual([]);
  });
});
