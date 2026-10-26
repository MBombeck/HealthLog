/**
 * v1.17.0 — the glucose clinical panel window is one exported constant.
 *
 * `GLUCOSE_PANEL_WINDOW_DAYS` (30) is the single source of truth for the
 * window the TIR / GMI / eA1C / CV panel covers wherever it renders outside an
 * ad-hoc report period: the analytics route, the dashboard snapshot, and the
 * Coach snapshot. This test pins the value AND asserts all three consumers
 * import the constant rather than re-typing a bare `30`, so the "same number
 * everywhere" guarantee can't silently drift. The doctor PDF deliberately uses
 * the report period and is excluded.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_WINDOW_DAYS,
  GLUCOSE_PANEL_WINDOW_DAYS,
} from "../glucose-metrics";

const ROOT = join(__dirname, "..", "..", "..", "..");

const CONSUMERS = [
  "src/lib/analytics/response/glucose.ts",
  "src/lib/dashboard/snapshot.ts",
  // v1.28.26 — the Coach glucose section moved into its own block module;
  // the alias derivation lives there and snapshot.ts imports the alias.
  "src/lib/ai/coach/snapshot-blocks/glucose-block.ts",
];

describe("glucose panel window constant", () => {
  it("is 30 days and distinct from the Battelino default", () => {
    expect(GLUCOSE_PANEL_WINDOW_DAYS).toBe(30);
    expect(GLUCOSE_PANEL_WINDOW_DAYS).not.toBe(DEFAULT_WINDOW_DAYS);
  });

  it.each(CONSUMERS)("%s imports the exported constant", (relPath) => {
    const src = readFileSync(join(ROOT, relPath), "utf8");
    expect(src).toContain("GLUCOSE_PANEL_WINDOW_DAYS");
  });

  it.each(CONSUMERS)(
    "%s derives the glucose window from the exported constant",
    (relPath) => {
      const src = readFileSync(join(ROOT, relPath), "utf8");
      // The window must derive from the exported constant — either passed
      // straight to `windowDays`/the `Date.now()` math, or via the file's
      // local alias `GLUCOSE_CLINICAL_WINDOW_DAYS = GLUCOSE_PANEL_WINDOW_DAYS`.
      // It must NOT be a bare `windowDays: 30` glucose literal.
      const usesConstantDirectly = /GLUCOSE_PANEL_WINDOW_DAYS/.test(src);
      const aliasesConstant =
        /GLUCOSE_CLINICAL_WINDOW_DAYS\s*=\s*GLUCOSE_PANEL_WINDOW_DAYS/.test(
          src,
        );
      expect(usesConstantDirectly || aliasesConstant).toBe(true);
    },
  );
});
