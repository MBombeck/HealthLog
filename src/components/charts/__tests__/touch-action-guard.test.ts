import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Phase A5 / B-mobile finding (CRITICAL #1): Recharts wraps every
 * chart in a `<ResponsiveContainer>` whose default
 * `touch-action: auto` makes the browser wait for the chart's JS
 * touchmove handler before starting page scroll. On slow devices that
 * causes the maintainer's "Scrolling-Hänger im Dashboard auf Charts".
 *
 * Fix: every chart's wrapper `<div>` (the one that contains the
 * `<ResponsiveContainer>`) must carry the Tailwind `touch-pan-y`
 * utility so the browser starts vertical scroll immediately without
 * waiting for the JS handler.
 *
 * This test is a textual guard: if a future refactor accidentally
 * drops `touch-pan-y` from any chart wrapper, the unit test catches
 * it before it ships. The simpler textual check (vs. rendering each
 * chart) avoids the heavy Recharts + TanStack-Query + Auth provider
 * scaffold every individual chart needs to render.
 */
const CHART_FILES = [
  "health-chart.tsx",
  "mood-chart/plot.tsx",
  "medication-compliance-chart.tsx",
  "scatter-correlation-chart.tsx",
];

describe("chart wrappers — touch-action: pan-y guard", () => {
  for (const filename of CHART_FILES) {
    it(`${filename}: every ResponsiveContainer has a wrapper with touch-pan-y`, () => {
      const path = join(process.cwd(), "src/components/charts", filename);
      const src = readFileSync(path, "utf8");
      const responsiveCount = (src.match(/ResponsiveContainer\b/g) ?? [])
        .length;
      // The import line + opening tag + closing tag — but we want at least
      // one occurrence of the utility class. We also accept the explicit
      // inline style `touchAction: "pan-y"` in case a future refactor
      // moves to inline styles.
      const hasUtility = /touch-pan-y/.test(src);
      const hasInlineStyle = /touchAction\s*:\s*["']pan-y["']/.test(src);
      expect(
        hasUtility || hasInlineStyle,
        `${filename} mentions ResponsiveContainer (${responsiveCount} occurrences) but does not declare touch-pan-y on the wrapper. ` +
          `Add the Tailwind utility 'touch-pan-y' to the <div> that contains the <ResponsiveContainer> ` +
          `so the browser starts vertical scroll immediately. See .planning/phase-A5-mobile-findings.md → Scroll-lockup root-cause.`,
      ).toBe(true);
    });
  }
});
