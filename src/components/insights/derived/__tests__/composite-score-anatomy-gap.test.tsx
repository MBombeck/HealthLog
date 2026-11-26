import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * A rhythm sub-score withheld for too few nights names the floor the server
 * published (`rhythmMinNights`), not a number the sheet carries itself.
 */

const anatomy = vi.fn();
vi.mock("../score-anatomy-view", () => ({
  ScoreAnatomyView: (props: Record<string, unknown>) => {
    anatomy(props);
    return null;
  },
}));
vi.mock("@/components/insights/insight-status-card", () => ({
  InsightStatusCard: () => null,
}));
vi.mock("../score-history", () => ({
  ScoreHistoryChart: () => null,
  ScoreTrendChartDynamic: () => null,
}));
vi.mock("@/lib/i18n/context", () => ({
  useFormatters: () => ({ dateShortSmartCalendar: (d: string) => d }),
  useTranslations: () => ({
    t: (key: string, vars?: Record<string, string | number>) =>
      vars ? `${key}:${JSON.stringify(vars)}` : key,
  }),
}));
vi.mock("../use-derived-metric", () => ({
  useDerivedMetric: () => ({
    isLoading: false,
    data: {
      status: "ok",
      value: {
        score: 70,
        band: "yellow",
        subScores: [
          { key: "consistency", value: null, weight: 0.2, gap: "few_nights" },
        ],
        rhythmNights: 2,
        rhythmMinNights: 5,
      },
      coverage: 1,
      confidence: "high",
      provenance: {},
    },
  }),
}));

import { CompositeScoreAnatomy } from "../composite-score-anatomy";

describe("sleep score sheet — the few-nights gap", () => {
  it("names the published floor", () => {
    renderToStaticMarkup(<CompositeScoreAnatomy metric="SLEEP_SCORE" />);
    const props = anatomy.mock.calls.at(-1)![0] as {
      contributors: Array<{ key: string; missingLabel?: string }>;
    };
    const consistency = props.contributors.find((c) => c.key === "consistency");
    expect(consistency?.missingLabel).toContain('"count":2');
    expect(consistency?.missingLabel).toContain('"needed":5');
  });
});
