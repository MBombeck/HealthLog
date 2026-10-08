import { describe, expect, it } from "vitest";

import { insightsHrefForMetric } from "@/lib/insights/metric-deep-link";
import { SUB_PAGE_SLUGS } from "@/lib/insights/sub-page-metric";
import { COACH_SOURCE_MEASUREMENT_TYPES } from "@/lib/ai/coach/source-measurement-types";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * The MCP `search` / `fetch` results link a metric as `/insights?metric=<id>`
 * in several spellings. Every one must land on the metric's own page; an id
 * that names nothing leaves the overview alone.
 */
describe("insightsHrefForMetric", () => {
  it("routes the Coach source keys the data inventory links carry", () => {
    expect(insightsHrefForMetric("hrv")).toBe("/insights/hrv");
    expect(insightsHrefForMetric("resting_hr")).toBe("/insights/resting-pulse");
    expect(insightsHrefForMetric("bp")).toBe("/insights/blood-pressure");
    expect(insightsHrefForMetric("weight")).toBe("/insights/weight");
    expect(insightsHrefForMetric("glucose")).toBe("/insights/blood-glucose");
    expect(insightsHrefForMetric("mood")).toBe("/insights/mood");
    expect(insightsHrefForMetric("workouts")).toBe("/insights/workouts");
  });

  it("routes signal keys and measurement types", () => {
    expect(insightsHrefForMetric("GRIP_STRENGTH")).toBe(
      "/insights/grip-strength",
    );
    expect(insightsHrefForMetric("CARDIO_RECOVERY")).toBe(
      "/insights/cardio-recovery",
    );
    expect(insightsHrefForMetric("HRV_RMSSD")).toBe("/insights/hrv");
  });

  it("falls back to the value list for a type no page focuses", () => {
    expect(insightsHrefForMetric("DAY_STRAIN")).toBe(
      "/insights/values/DAY_STRAIN",
    );
  });

  it("routes a sub-page slug in either separator", () => {
    expect(insightsHrefForMetric("walking-speed")).toBe(
      "/insights/walking-speed",
    );
    expect(insightsHrefForMetric("walking_speed")).toBe(
      "/insights/walking-speed",
    );
  });

  it("leaves the overview for an id it cannot place", () => {
    for (const id of [null, "", "  ", "nonsense", "../admin", "a".repeat(80)]) {
      expect(insightsHrefForMetric(id)).toBeNull();
    }
  });

  it("only ever points at a page that exists", () => {
    const ids = [
      ...SUB_PAGE_SLUGS,
      ...Object.keys(COACH_SOURCE_MEASUREMENT_TYPES),
    ];
    for (const id of ids) {
      const href = insightsHrefForMetric(id);
      if (!href || href.startsWith("/insights/values/")) continue;
      const dir = join(process.cwd(), "src/app", href);
      expect(existsSync(join(dir, "page.tsx")), `${id} → ${href}`).toBe(true);
    }
  });
});
