/**
 * v1.16.11 (#316) — as-needed (PRN) medications are excluded from every
 * surface that computes or displays a compliance rate. A PRN medication
 * has no expected doses, so it must contribute NEITHER 0% NOR 100% to
 * any rate, streak, or aggregate.
 *
 * Source pins: each call site that feeds the compliance engine fetches
 * its medications with an explicit `asNeeded: false` predicate. The pin
 * walks every rate-surfacing `findMany` and fails if a PRN medication
 * could enter a scheduled-dose rate.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const CALL_SITES: Array<{ file: string; surface: string }> = [
  {
    file: "src/lib/insights/blood-pressure-status.ts",
    surface: "BP-status compliance gate",
  },
  {
    file: "src/lib/insights/medication-compliance-status.ts",
    surface: "nightly medication-compliance status",
  },
  {
    file: "src/lib/insights/features.ts",
    surface: "insight feature extraction (c7/c30/c90)",
  },
  {
    file: "src/lib/targets/build-response.ts",
    surface: "insight targets",
  },
  {
    file: "src/lib/insights/comprehensive-overview/medication-compliance.ts",
    surface: "comprehensive insight",
  },
  {
    file: "src/lib/ai/coach/snapshot.ts",
    surface: "Coach prompt compliance context",
  },
  {
    file: "src/app/api/medications/compliance/route.ts",
    surface: "batched card/table compliance payload",
  },
];

/**
 * The medication-feeding read at each call site must carry the
 * exclusion inside its `where`: an `asNeeded: false` predicate within
 * the few lines following a `medication.findMany(` opener (comment
 * lines between them are fine).
 */
function hasExcludingFindMany(source: string): boolean {
  let from = 0;
  for (;;) {
    const at = source.indexOf("medication.findMany(", from);
    if (at < 0) return false;
    const window = source.slice(at, at + 600);
    // No dot in the pattern, so no dotall flag is needed — `[^}]` and
    // `\s` both span newlines.
    if (/where:\s*\{[^}]*\basNeeded:\s*false\b/.test(window)) return true;
    from = at + 1;
  }
}

describe("as-needed compliance exclusion — source pins (v1.16.11, #316)", () => {
  for (const { file, surface } of CALL_SITES) {
    it(`${surface} excludes asNeeded medications (${file})`, () => {
      const source = readFileSync(resolve(process.cwd(), file), "utf8");
      expect(
        hasExcludingFindMany(source),
        `${file} must fetch medications with \`asNeeded: false\``,
      ).toBe(true);
    });
  }

  it("the reminder tick carries the same predicate", () => {
    const source = readFileSync(
      resolve(
        process.cwd(),
        "src/lib/jobs/reminder/medication-reminder-check.ts",
      ),
      "utf8",
    );
    expect(hasExcludingFindMany(source)).toBe(true);
  });
});
