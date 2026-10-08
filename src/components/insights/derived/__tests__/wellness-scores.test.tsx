import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import type {
  DerivedMetricResponse,
  DerivedBatchToken,
} from "../use-derived-metric";
import { WellnessScores } from "../wellness-scores";

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

type Resp = DerivedMetricResponse<Record<string, unknown>>;

function ok(value: Record<string, unknown>): Resp {
  return {
    metric: "X",
    status: "ok",
    value,
    coverage: {
      requiredInputs: 1,
      presentInputs: 1,
      historyDays: 30,
      missing: [],
    },
    confidence: { score: 90, band: "high" },
    provenance: { inputs: [], source: "DAY", windowDays: 30, computedAt: "x" },
    reason: null,
  };
}

function absent(): Resp {
  return {
    metric: "X",
    status: "insufficient",
    value: null,
    coverage: {
      requiredInputs: 1,
      presentInputs: 0,
      historyDays: 0,
      missing: [],
    },
    confidence: null,
    provenance: { inputs: [], source: "none", windowDays: 30, computedAt: "x" },
    reason: "no_readings_in_window",
  };
}

function readFrom(
  map: Record<string, Resp>,
): <T>(token: DerivedBatchToken) => DerivedMetricResponse<T> | null {
  return <T,>(token: DerivedBatchToken) =>
    (map[token.metric] ?? absent()) as unknown as DerivedMetricResponse<T>;
}

describe("<WellnessScores>", () => {
  it("un-mounts the whole strip when no score has data", () => {
    const html = render(
      <WellnessScores read={readFrom({})} isLoading={false} />,
    );
    expect(html).toBe("");
  });

  it("renders a skeleton row while loading, not a pop-in later", () => {
    const html = render(
      <WellnessScores
        read={readFrom({ READINESS: ok({ score: 80, band: "green" }) })}
        isLoading
      />,
    );
    // The section heading + a row of tile-shaped skeletons render
    // immediately, so the strip reserves its final height instead of
    // vanishing (`return null`) and popping in once the batch resolves.
    expect(html).toContain('data-slot="wellness-scores"');
    expect(html).toContain('data-slot="wellness-scores-grid"');
    expect(html).toContain('data-slot="wellness-score-tile-skeleton"');
    expect(html).not.toContain('data-slot="wellness-score-tile"');
  });

  it("renders a ring tile with an icon + heading on the gentle wellness surface", () => {
    const html = render(
      <WellnessScores
        read={readFrom({ READINESS: ok({ score: 82, band: "green" }) })}
        isLoading={false}
      />,
    );
    expect(html).toContain('data-slot="wellness-scores"');
    expect(html).toContain('data-slot="wellness-score-tile"');
    expect(html).toContain('data-metric="READINESS"');
    // The tile rides the gentle, hero-family `.wellness-tile` surface
    // (asserted by the stable class, not viewport text).
    expect(html).toContain("wellness-tile");
    // The ring carries its band on the data-attribute.
    expect(html).toContain('data-band="green"');
    // The band word renders under the ring (semantic kept off the arc hue).
    expect(html).toContain('data-slot="wellness-score-band-word"');
  });

  it("renders one tile per available score and hides absent ones", () => {
    const html = render(
      <WellnessScores
        read={readFrom({
          READINESS: ok({ score: 80, band: "green" }),
          SLEEP_SCORE: ok({ score: 55, band: "yellow" }),
        })}
        isLoading={false}
      />,
    );
    expect(html).toContain('data-metric="READINESS"');
    expect(html).toContain('data-metric="SLEEP_SCORE"');
    expect(html).not.toContain('data-metric="RECOVERY_SCORE"');
    expect(html).not.toContain('data-metric="STRESS_SCORE"');
    expect(html).not.toContain('data-metric="STRAIN_SCORE"');
  });

  it("drops the Strain tile when hideStrain is set (cycle ring takes its slot)", () => {
    const scores = {
      READINESS: ok({ score: 80, band: "green" }),
      STRAIN_SCORE: ok({ score: 40, band: "yellow" }),
    };
    // Without the flag Strain renders.
    const withStrain = render(
      <WellnessScores read={readFrom(scores)} isLoading={false} />,
    );
    expect(withStrain).toContain('data-metric="STRAIN_SCORE"');

    // With the flag Strain is suppressed while the other score stays.
    const hidden = render(
      <WellnessScores read={readFrom(scores)} isLoading={false} hideStrain />,
    );
    expect(hidden).not.toContain('data-metric="STRAIN_SCORE"');
    expect(hidden).toContain('data-metric="READINESS"');
  });

  it("draws each tile's course under its band word, naming the window", () => {
    const html = render(
      <WellnessScores
        read={readFrom({
          RECOVERY_SCORE: ok({
            score: 70,
            band: "yellow",
            series: [60, 64, 70],
          }),
          STRESS_SCORE: ok({ score: 30, band: "green", series: [] }),
        })}
        isLoading={false}
      />,
    );
    const recovery = html.slice(
      html.indexOf('data-metric="RECOVERY_SCORE"'),
      html.indexOf('data-metric="STRESS_SCORE"'),
    );
    expect(recovery).toContain('data-slot="wellness-score-history"');
    expect(recovery).toContain("Last 30 days");
    // A score without a course draws no empty line.
    const stress = html.slice(html.indexOf('data-metric="STRESS_SCORE"'));
    expect(stress).not.toContain('data-slot="wellness-score-history"');
  });

  it("reserves the history band in the loading skeleton", () => {
    const html = render(<WellnessScores read={readFrom({})} isLoading />);
    const tile = html.slice(
      html.indexOf('data-slot="wellness-score-tile-skeleton"'),
    );
    expect(tile).toContain("h-10 w-full");
  });
});
