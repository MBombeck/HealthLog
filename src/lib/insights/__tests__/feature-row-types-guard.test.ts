/**
 * The feature extraction's bulk read asks for the types in
 * `FEATURE_ROW_TYPES` and nothing else (#1398: each type is capped on its
 * own, so the read has to name them). A block that starts folding another
 * type through `byType("…")` would get no rows and quietly stop being built,
 * so every type a block reads must be on the list, including the signals of
 * the day, which are handed `byType` narrowed to each day's ladder-winning
 * source (`canonicalSignalRows`).
 */
import { describe, expect, it } from "vitest";

import { readSource } from "@/__tests__/helpers/source-files";

const src = readSource("src/lib/insights/features.ts", [
  "const FEATURE_ROW_TYPES",
  "canonicalSignalRows(byType,",
]);
const signals = readSource("src/lib/insights/signals-of-day.ts", [
  "byType: (type: string)",
]);

describe("feature extraction row types", () => {
  it("reads every type a block folds", () => {
    const list = /const FEATURE_ROW_TYPES[^=]*=\s*\[([\s\S]*?)\];/.exec(src);
    expect(list).not.toBeNull();
    const listed = new Set(
      [...list![1].matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]),
    );
    const folded = new Set(
      [src, signals].flatMap((text) =>
        [...text.matchAll(/\bbyType\(\s*"([A-Z_]+)"\s*\)/g)].map((m) => m[1]),
      ),
    );
    // A matcher that finds nothing would pass the subset check below.
    expect(folded.size).toBeGreaterThanOrEqual(10);
    expect([...folded].filter((t) => !listed.has(t))).toEqual([]);
  });
});
