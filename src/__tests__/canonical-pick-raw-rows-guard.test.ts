/**
 * Structural guard: an aggregate over a window does not rank every raw
 * reading to pick the canonical source.
 *
 * `canonicalMeasurementsCte` names each (type, day)'s source with a window
 * function over every reading it reads. That is the right tool for a reader
 * that hands individual readings on (a chart's raw points, the blood-pressure
 * pairing), and the wrong one for an aggregate: on a dense stream (a watch
 * syncing about 35 000 pulse readings a day) the 90-day means and median of
 * the dashboard slice sorted three million rows per call, and the slice is
 * rebuilt after every sync, so the daily digest took one to four seconds. An
 * aggregate folds the readings first and picks over the folded cells
 * (`canonical-window.ts`, `dense-series-read.ts`, `pre-fold-remainder.ts`).
 *
 * Every call of the helper in `src/lib` and `src/app` is listed below with
 * the reason it hands on raw readings or why its window stays small. A new
 * call fails here until it is listed, which is the point at which to ask
 * whether it is an aggregate. The floor fails the guard if the matcher stops
 * finding the calls at all.
 */
import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { scanSourceMatches } from "./helpers/source-files";

const SRC = join(__dirname, "..");

const ALLOWED: Record<string, { count: number; reason: string }> = {
  "lib/insights/comprehensive-aggregator.ts": {
    count: 2,
    reason:
      "the blood-pressure and weight readings for the ±5-minute pairing (two sparse types; the type filter reaches the scan), and the cold fallback for an account without rollups",
  },
  "lib/analytics/bp-in-target-fast-path.ts": {
    count: 1,
    reason:
      "one blood-pressure type's readings for the in-target pairing; sparse, and the type filter reaches the scan",
  },
  "lib/analytics/summaries-slice.ts": {
    count: 2,
    reason:
      "the cold fallback for an account without rollups (all-time figures and the live trend regression, which needs each reading's instant)",
  },
  "lib/measurements/series-canonical.ts": {
    count: 1,
    reason:
      "a chart's raw points of one type (inside 90 days and under the raw row cap) and the activity calendar's day totals of one sparse type",
  },
};

describe("raw-row canonical pick", () => {
  const matches = scanSourceMatches(
    SRC,
    /\bcanonicalMeasurements(?:Cte|From)\s*\(/g,
    {
      fileFloor: 1000,
      matchFloor: 6,
      stripComments: true,
      include: (rel) =>
        (rel.startsWith("lib/") || rel.startsWith("app/")) &&
        !rel.includes("__tests__") &&
        rel !== "lib/analytics/source-rank-sql.ts",
    },
  );

  it("is called only where it is listed, as often as it is listed", () => {
    const counts = new Map<string, number>();
    for (const m of matches) counts.set(m.file, (counts.get(m.file) ?? 0) + 1);
    const listed = Object.fromEntries(
      Object.entries(ALLOWED).map(([file, a]) => [file, a.count]),
    );
    expect(Object.fromEntries(counts)).toEqual(listed);
  });

  it("gives every listed call a reason", () => {
    for (const [file, { reason }] of Object.entries(ALLOWED)) {
      expect(reason.length, file).toBeGreaterThan(20);
    }
  });

  it("keeps the launch reads' window aggregate on the folded cells", () => {
    const slice = matches.filter(
      (m) => m.file === "lib/analytics/summaries-slice.ts",
    );
    // Both remaining calls sit in the cold fallback, after its declaration.
    const src = scanSourceMatches(
      SRC,
      /async function computeFromLiveAggregate\(/g,
      {
        fileFloor: 1,
        matchFloor: 1,
        include: (rel) => rel === "lib/analytics/summaries-slice.ts",
      },
    );
    for (const m of slice) expect(m.line).toBeGreaterThan(src[0].line);
  });
});
