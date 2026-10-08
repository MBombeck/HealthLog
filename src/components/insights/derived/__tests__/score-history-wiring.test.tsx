import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * v1.42 — every score's detail page shows its course right under the score
 * card, and the warning-coloured "descriptive proxy, not clinical" line no
 * longer rides above the method.
 *
 * The stored nightly scores (recovery, stress, strain) get the full metric
 * chart over their measurement type; the two composites draw the course their
 * value carries, and nothing when it carries fewer than two points. The chart
 * and the card are stubbed to probes that state what they were given.
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
  ScoreHistoryChart: ({ type }: { type: string }) => (
    <div data-slot="history-chart-probe" data-type={type} />
  ),
  ScoreHistoryCard: ({
    series,
    windowDays,
  }: {
    series: number[];
    windowDays: number;
  }) => (
    <div
      data-slot="history-card-probe"
      data-points={series.length}
      data-window={windowDays}
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
      expect(html).not.toContain("history-card-probe");
      // Under the score card, not somewhere else on the page.
      expect(html.indexOf("history-chart-probe")).toBeGreaterThan(
        html.indexOf("anatomy-probe"),
      );
    },
  );

  it.each(["SLEEP_SCORE", "READINESS"] as const)(
    "%s draws the course its value carries, over its window",
    (metric) => {
      const html = render(metric, [55, 61, 70]);
      expect(html).toContain('data-points="3"');
      expect(html).toContain('data-window="30"');
      expect(html).not.toContain("history-chart-probe");
    },
  );

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

  it("a composite with fewer than two points draws no course", () => {
    expect(render("READINESS", [70])).not.toContain("history-card-probe");
    expect(render("READINESS")).not.toContain("history-card-probe");
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
