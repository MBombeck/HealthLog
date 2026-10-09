import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * v1.42 — every score's detail page shows its course right under the score
 * card, and the warning-coloured "descriptive proxy, not clinical" line no
 * longer rides above the method.
 *
 * The stored nightly scores (recovery, stress, strain) get the full metric
 * chart over their measurement type; the two composites chart the daily
 * history the score-history route serves. Every one of them remembers its
 * range tab under its own slot. The charts and the card are stubbed to probes
 * that state what they were given.
 */

vi.mock("@/lib/i18n/context", () => ({
  useTranslations: () => ({ t: (key: string) => key }),
}));

const derived = { current: {} as Record<string, unknown> };
vi.mock("../use-derived-metric", () => ({
  useDerivedMetric: () => derived.current,
}));

vi.mock("@/components/insights/insight-status-card", () => ({
  InsightStatusCard: () => <div data-slot="assessment-probe" />,
}));

vi.mock("../score-anatomy-view", () => ({
  ScoreAnatomyView: ({ method }: { method: React.ReactNode }) => (
    <div data-slot="anatomy-probe">{method}</div>
  ),
}));

vi.mock("../score-history", () => ({
  ScoreHistoryChart: ({
    type,
    chartKey,
  }: {
    type: string;
    chartKey: string;
  }) => (
    <div
      data-slot="history-chart-probe"
      data-type={type}
      data-chart-key={chartKey}
    />
  ),
  ScoreTrendChartDynamic: ({
    score,
    chartKey,
  }: {
    score: string;
    chartKey: string;
  }) => (
    <div
      data-slot="trend-chart-probe"
      data-score={score}
      data-chart-key={chartKey}
    />
  ),
}));

import {
  CompositeScoreAnatomy,
  type AnatomyMetricId,
} from "../composite-score-anatomy";

function render(metric: AnatomyMetricId, series?: number[]): string {
  derived.current = {
    isLoading: false,
    isError: false,
    data: {
      status: "ok",
      value: {
        score: 70,
        band: "yellow",
        subScores: [],
        components: [],
        series,
      },
      coverage: {},
      confidence: null,
      provenance: { windowDays: 30 },
      assessment: null,
    },
  };
  return renderToStaticMarkup(<CompositeScoreAnatomy metric={metric} />);
}

describe("score detail history", () => {
  it.each(["RECOVERY_SCORE", "STRESS_SCORE", "STRAIN_SCORE"] as const)(
    "%s gets the full chart over its stored type",
    (metric) => {
      const html = render(metric, [60, 70]);
      expect(html).toContain(
        `data-slot="history-chart-probe" data-type="${metric}"`,
      );
      expect(html).not.toContain("trend-chart-probe");
      // Under the score card, not somewhere else on the page.
      expect(html.indexOf("history-chart-probe")).toBeGreaterThan(
        html.indexOf("anatomy-probe"),
      );
    },
  );

  it.each([
    ["SLEEP_SCORE", "scoreSleep"],
    ["READINESS", "scoreReadiness"],
  ] as const)(
    "%s charts its daily history from the score-history route",
    (metric, chartKey) => {
      const html = render(metric, [55, 61, 70]);
      expect(html).toContain(
        `data-slot="trend-chart-probe" data-score="${metric}" data-chart-key="${chartKey}"`,
      );
      expect(html).not.toContain("history-chart-probe");
      expect(html.indexOf("trend-chart-probe")).toBeGreaterThan(
        html.indexOf("anatomy-probe"),
      );
    },
  );

  it.each([
    ["RECOVERY_SCORE", "scoreRecovery"],
    ["STRESS_SCORE", "scoreStress"],
    ["STRAIN_SCORE", "scoreStrain"],
  ] as const)("%s remembers its range under %s", (metric, chartKey) => {
    expect(render(metric)).toContain(`data-chart-key="${chartKey}"`);
  });

  it("an account without a score gets no empty chart under the insufficient card", () => {
    derived.current = {
      isLoading: false,
      isError: false,
      data: {
        status: "insufficient",
        value: null,
        coverage: {},
        confidence: null,
        provenance: { windowDays: 14 },
        assessment: null,
      },
    };
    const html = renderToStaticMarkup(
      <CompositeScoreAnatomy metric="RECOVERY_SCORE" />,
    );
    expect(html).toContain("anatomy-probe");
    expect(html).not.toContain("history-chart-probe");
  });

  it("a composite charts its history even when its value carries no series", () => {
    // The course no longer rides the value: one point, or none, still gets
    // the chart, whose own range decides what it shows.
    expect(render("READINESS", [70])).toContain("trend-chart-probe");
    expect(render("READINESS")).toContain("trend-chart-probe");
  });

  it("no score page carries the caveat line above its method", () => {
    for (const metric of [
      "SLEEP_SCORE",
      "READINESS",
      "RECOVERY_SCORE",
      "STRESS_SCORE",
      "STRAIN_SCORE",
    ] as const) {
      const html = render(metric, [60, 70]);
      expect(html).toContain(`insights.derived.composite.${metric}.method`);
      expect(html).not.toContain(".caveat");
      expect(html).not.toContain("text-warning");
    }
  });
});
