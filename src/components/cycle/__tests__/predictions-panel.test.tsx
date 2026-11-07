import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { PredictionsPanel } from "../predictions-panel";
import { I18nProvider } from "@/lib/i18n/context";
import type { CyclePrediction, CycleHistoryResponse } from "../types";

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

const basePrediction: CyclePrediction = {
  method: "CALENDAR",
  nextPeriodStart: "2026-07-01",
  nextPeriodStartLow: "2026-06-29",
  nextPeriodStartHigh: "2026-07-03",
  fertileWindowStart: null,
  fertileWindowEnd: null,
  predictedOvulation: null,
  ovulationConfirmed: false,
  confidence: 0.8,
  cyclesObserved: 6,
  stillLearning: false,
  disclaimer: "Estimates only, not medical advice.",
};

const emptyHistory: CycleHistoryResponse = {
  cycles: [],
  stats: {
    avgLengthDays: null,
    lengthVariabilityDays: null,
    avgPeriodLengthDays: null,
    regularity: "LEARNING",
  },
};

describe("<PredictionsPanel>", () => {
  it("renders the next-period range without repeating the non-medical disclaimer", () => {
    // The disclaimer now lives once at the cycle-tracking on-ramp, never beneath
    // the prediction surfaces, so the panel must not render it for any goal.
    const html = render(
      <PredictionsPanel
        prediction={basePrediction}
        rawChartMode={false}
        history={emptyHistory}
      />,
    );
    expect(html).not.toContain('data-slot="cycle-disclaimer"');
    expect(html).not.toContain("Estimates only, not medical advice.");
    // The range (not a single date) renders.
    expect(html).toContain("–");
  });

  it("renders the fertile window only when the prediction carries one", () => {
    const withFertile: CyclePrediction = {
      ...basePrediction,
      fertileWindowStart: "2026-06-14",
      fertileWindowEnd: "2026-06-19",
      predictedOvulation: "2026-06-17",
    };
    const html = render(
      <PredictionsPanel
        prediction={withFertile}
        rawChartMode={false}
        history={emptyHistory}
      />,
    );
    expect(html).toContain("Fertile window");
    expect(html).toContain("Estimated ovulation");
  });

  it("suppresses fertile-window language when the prediction nulls it (goal-gated server-side)", () => {
    const html = render(
      <PredictionsPanel
        prediction={basePrediction}
        rawChartMode={false}
        history={emptyHistory}
      />,
    );
    expect(html).not.toContain("Fertile window");
  });

  it("shows the still-learning state for an under-3-cycle prediction", () => {
    const html = render(
      <PredictionsPanel
        prediction={{ ...basePrediction, stillLearning: true }}
        rawChartMode={false}
        history={emptyHistory}
      />,
    );
    expect(html).toContain("Still learning");
  });

  it("shows the raw-chart-mode state when predictions are off", () => {
    const html = render(
      <PredictionsPanel
        prediction={null}
        rawChartMode={true}
        history={emptyHistory}
      />,
    );
    expect(html).toContain("Prediction is off");
  });
});

describe("<PredictionsPanel> later cycles (#1350)", () => {
  const projection = [
    {
      k: 1,
      start: "2026-07-01",
      periodLength: 5,
      bandStart: "2026-06-29",
      bandEnd: "2026-07-03",
    },
    {
      k: 2,
      start: "2026-07-29",
      periodLength: 5,
      bandStart: "2026-07-26",
      bandEnd: "2026-08-01",
    },
    {
      k: 3,
      start: "2026-08-26",
      periodLength: 5,
      bandStart: "2026-08-22",
      bandEnd: "2026-08-30",
    },
  ];

  it("lists the cycles after the next one, as the server's windows", () => {
    const html = render(
      <PredictionsPanel
        prediction={basePrediction}
        rawChartMode={false}
        history={emptyHistory}
        projection={projection}
        projectionState="OK"
      />,
    );
    expect(html).toContain('data-slot="cycle-projection"');
    expect(html).toContain("Later cycles");
    // Two later rows; cycle 1 is the next-period row above them.
    expect(html.match(/Around /g)).toHaveLength(2);
  });

  it("states a late period instead of listing later cycles", () => {
    const html = render(
      <PredictionsPanel
        prediction={basePrediction}
        rawChartMode={false}
        history={emptyHistory}
        projection={[]}
        projectionState="LATE"
      />,
    );
    expect(html).toContain('data-slot="cycle-projection-late"');
    expect(html).not.toContain('data-slot="cycle-projection"');
  });
});
