import { describe, it, expect } from "vitest";

import type { DailyBriefing, DailyBriefingKeyFinding } from "@/lib/ai/schema";
import {
  selectTrendCharts,
  DEFAULT_TREND_CHART_CAP,
  TREND_CHART_CONFIG,
} from "../trend-chart-select";

/**
 * v1.8.5 — the Trends row charts the metrics the daily briefing flags,
 * in briefing order, deduped, capped, with the legacy BP / weight /
 * mood triple as the fallback. These tests pin the selection contract;
 * the renderer is a thin consumer.
 */

function finding(
  sourceMetric: DailyBriefingKeyFinding["sourceMetric"],
): DailyBriefingKeyFinding {
  return {
    tone: "watch",
    headline: `${sourceMetric} headline`,
    detail: `${sourceMetric} detail`,
    delta: null,
    sourceWindow: "30d",
    sourceMetric,
  };
}

function briefing(
  metrics: DailyBriefingKeyFinding["sourceMetric"][],
): DailyBriefing {
  return {
    paragraph: "Synthesised briefing paragraph.",
    keyFindings: metrics.map(finding),
  };
}

describe("selectTrendCharts", () => {
  it("falls back to the BP / weight / mood triple when the briefing is null", () => {
    const charts = selectTrendCharts(null);
    expect(charts.map((c) => c.metric)).toEqual(["bp", "weight", "mood"]);
  });

  it("falls back to the default triple when the briefing is undefined", () => {
    const charts = selectTrendCharts(undefined);
    expect(charts.map((c) => c.metric)).toEqual(["bp", "weight", "mood"]);
  });

  it("falls back when the briefing carries no key findings", () => {
    const charts = selectTrendCharts(briefing([]));
    expect(charts.map((c) => c.metric)).toEqual(["bp", "weight", "mood"]);
  });

  it("charts exactly the metrics the briefing flags, in briefing order", () => {
    const charts = selectTrendCharts(briefing(["weight", "pulse", "sleep"]));
    expect(charts.map((c) => c.metric)).toEqual(["weight", "pulse", "sleep"]);
  });

  it("dedupes repeated metrics, keeping first-seen order", () => {
    const charts = selectTrendCharts(briefing(["bp", "weight", "bp", "pulse"]));
    expect(charts.map((c) => c.metric)).toEqual(["bp", "weight", "pulse"]);
  });

  it("caps at the default of three", () => {
    const charts = selectTrendCharts(
      briefing(["weight", "pulse", "sleep", "hrv", "steps"]),
    );
    expect(charts).toHaveLength(DEFAULT_TREND_CHART_CAP);
    expect(charts.map((c) => c.metric)).toEqual(["weight", "pulse", "sleep"]);
  });

  it("honours a custom cap", () => {
    const charts = selectTrendCharts(briefing(["weight", "pulse", "sleep"]), {
      cap: 2,
    });
    expect(charts.map((c) => c.metric)).toEqual(["weight", "pulse"]);
  });

  it("clamps a zero/negative cap to at least one", () => {
    const charts = selectTrendCharts(briefing(["weight", "pulse"]), { cap: 0 });
    expect(charts).toHaveLength(1);
    expect(charts[0].metric).toBe("weight");
  });

  it("skips metrics with no standalone trend chart (compliance, glp1_plateau)", () => {
    const charts = selectTrendCharts(
      briefing(["compliance", "weight", "glp1_plateau", "pulse"]),
    );
    expect(charts.map((c) => c.metric)).toEqual(["weight", "pulse"]);
  });

  it("falls back to the default triple when every finding is chartless", () => {
    const charts = selectTrendCharts(briefing(["compliance", "glp1_plateau"]));
    expect(charts.map((c) => c.metric)).toEqual(["bp", "weight", "mood"]);
  });

  it("resolves additive HealthKit metrics to a chart config", () => {
    const charts = selectTrendCharts(briefing(["hrv", "active_energy"]));
    expect(charts.map((c) => c.metric)).toEqual(["hrv", "active_energy"]);
    expect(charts[0].types).toEqual(["HEART_RATE_VARIABILITY"]);
    expect(charts[1].types).toEqual(["ACTIVE_ENERGY_BURNED"]);
  });

  it("carries an annotation key only for the legacy triple", () => {
    const charts = selectTrendCharts(briefing(["bp", "weight", "mood"]));
    expect(charts.map((c) => c.annotationKey)).toEqual([
      "bp",
      "weight",
      "mood",
    ]);
    const pulseCharts = selectTrendCharts(briefing(["pulse"]));
    expect(pulseCharts[0].annotationKey).toBeUndefined();
  });

  it("maps the mood slot to the bespoke mood chart kind", () => {
    const charts = selectTrendCharts(briefing(["mood"]));
    expect(charts[0].kind).toBe("mood");
    expect(charts[0].types).toEqual([]);
  });

  it("every chart-bearing sourceMetric carries a standard caption key", () => {
    // v1.8.6 W8 — a tile without an advisor annotation used to paint
    // empty space below the chart. Every chart config now carries a
    // `captionKey` so the renderer can always surface a caption. This
    // guard keeps a future metric addition from re-opening the gap.
    for (const [metric, config] of Object.entries(TREND_CHART_CONFIG)) {
      if (!config) continue;
      expect(config.captionKey, `${metric} captionKey`).toMatch(
        /^insights\.trendsRow\.caption\./,
      );
    }
  });

  it("every chart-bearing sourceMetric resolves to a non-empty health-chart series", () => {
    for (const [metric, config] of Object.entries(TREND_CHART_CONFIG)) {
      if (!config) continue;
      if (config.kind === "health-chart") {
        expect(config.types.length, `${metric} types`).toBeGreaterThan(0);
        expect(config.colors.length, `${metric} colors`).toBeGreaterThanOrEqual(
          config.types.length,
        );
      }
    }
  });

  it("every chart-bearing sourceMetric carries a routed detailHref", () => {
    // v1.18.6 — the overview Trends row drills into the metric's detail page.
    // Each chartable slot must resolve to a `/insights/<slug>` target so the
    // cross-link never lands on a non-route — steps in particular.
    for (const [metric, config] of Object.entries(TREND_CHART_CONFIG)) {
      if (!config) continue;
      expect(config.detailHref, `${metric} detailHref`).toMatch(
        /^\/insights\//,
      );
    }
    expect(TREND_CHART_CONFIG.steps?.detailHref).toBe("/insights/steps");
  });
});

describe("selectTrendCharts — hidden metrics", () => {
  it("drops mood from the fallback triple when the mood module is off", () => {
    const charts = selectTrendCharts(null, { hiddenMetrics: ["mood"] });
    expect(charts.map((c) => c.metric)).not.toContain("mood");
    expect(charts).toHaveLength(2);
  });

  it("skips a hidden metric the briefing flags", () => {
    const charts = selectTrendCharts(briefing(["mood", "weight"]), {
      hiddenMetrics: ["mood"],
    });
    expect(charts.map((c) => c.metric)).not.toContain("mood");
    expect(charts).toHaveLength(1);
  });

  it("keeps mood when nothing is hidden", () => {
    const charts = selectTrendCharts(null, { hiddenMetrics: [] });
    expect(charts.map((c) => c.metric)).toContain("mood");
  });
});
