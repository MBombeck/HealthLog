import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * 1.50 — every score page reads in one order, the app's too: the assessment
 * first, then what counts (the anatomy card with its rows, or the one
 * sentence a score without parts shows), then the course. The label and the
 * sentence come from the server's `origin`.
 */

const value = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock("../score-anatomy-view", () => ({
  ScoreAnatomyView: (props: Record<string, unknown>) => (
    <i
      data-part="anatomy"
      data-origin={String(props.originLabel ?? "")}
      data-note={String(props.noFactorsNote ?? "")}
    />
  ),
}));
vi.mock("@/components/insights/insight-status-card", () => ({
  InsightStatusCard: () => <i data-part="assessment" />,
}));
vi.mock("../score-history", () => ({
  ScoreHistoryChart: () => <i data-part="history" />,
  ScoreTrendChartDynamic: () => <i data-part="history" />,
}));
vi.mock("@/lib/i18n/context", () => ({
  useFormatters: () => ({ dateShortSmartCalendar: (d: string) => d }),
  useTranslations: () => ({
    t: (key: string) => key,
    locale: "en",
  }),
}));
vi.mock("../use-derived-metric", () => ({
  useDerivedMetric: () => ({
    isLoading: false,
    data: {
      status: "ok",
      value: value.current,
      coverage: {},
      confidence: { score: 90, band: "high" },
      provenance: {},
      assessment: { text: "Higher than most days.", updatedAt: "x" },
    },
  }),
}));

import { CompositeScoreAnatomy } from "../composite-score-anatomy";

function parts(html: string): string[] {
  return [...html.matchAll(/data-part="(\w+)"/g)].map((m) => m[1]);
}

describe("score page order", () => {
  it("puts the assessment first, then the anatomy, then the course", () => {
    value.current = {
      score: 71,
      band: "red",
      series: [60, 71],
      origin: "estimate",
      deviceSource: null,
    };
    const html = renderToStaticMarkup(
      <CompositeScoreAnatomy metric="STRESS_SCORE" />,
    );
    expect(parts(html)).toEqual(["assessment", "anatomy", "history"]);
    expect(html).toContain('data-origin="insights.scores.origin.estimate"');
    expect(html).toContain('data-note="insights.scores.estimateNoFactors"');
  });

  it("names a device strain as the device's value, with the device sentence", () => {
    value.current = {
      score: 59,
      band: "yellow",
      series: [50, 59],
      device: { value: 12.4, scaleMax: 21 },
      origin: "device",
      deviceSource: "WHOOP",
    };
    const html = renderToStaticMarkup(
      <CompositeScoreAnatomy metric="STRAIN_SCORE" />,
    );
    expect(html).toContain('data-origin="insights.scores.origin.device"');
    expect(html).toContain('data-note="insights.scores.deviceNoFactors"');
  });

  it("gives a blended recovery with its parts neither label nor sentence", () => {
    value.current = {
      score: 64,
      band: "yellow",
      series: [60, 64],
      components: [{ key: "hrv", value: 70, weight: 1 }],
      origin: "computed",
      deviceSource: null,
    };
    const html = renderToStaticMarkup(
      <CompositeScoreAnatomy metric="RECOVERY_SCORE" />,
    );
    expect(html).toContain('data-origin=""');
    expect(html).toContain('data-note=""');
  });
});
