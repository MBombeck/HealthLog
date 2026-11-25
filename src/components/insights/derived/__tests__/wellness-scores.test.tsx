import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import type { HealthScoreReport } from "@/lib/analytics/score/types";
import type {
  DerivedMetricResponse,
  DerivedBatchToken,
} from "../use-derived-metric";
import { WellnessScores } from "../wellness-scores";

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider initialLocale="en">{node}</I18nProvider>
    </QueryClientProvider>,
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

/** A Health score report with a scored composite and the given pillars. */
function report(
  score: number,
  band: "green" | "yellow" | "red",
  pillars: HealthScoreReport["pillars"] = [],
): HealthScoreReport {
  return {
    composite: {
      status: "ok",
      value: { score, band },
    },
    pillars,
  } as unknown as HealthScoreReport;
}

const none = { healthScore: null, healthPending: false } as const;

describe("<WellnessScores> (the Insights head)", () => {
  it("un-mounts when no score has data", () => {
    const html = render(
      <WellnessScores read={readFrom({})} isLoading={false} {...none} />,
    );
    expect(html).toBe("");
  });

  it("renders three skeleton tiles while loading, not a pop-in later", () => {
    const html = render(
      <WellnessScores
        read={readFrom({ READINESS: ok({ score: 80, band: "green" }) })}
        isLoading
        {...none}
      />,
    );
    expect(html).toContain('data-slot="wellness-scores-grid"');
    expect(
      html.match(/data-slot="wellness-score-tile-skeleton"/g),
    ).toHaveLength(3);
    expect(html).not.toContain('data-slot="wellness-score-tile"');
  });

  it("holds the skeleton while the Health score is still on its way", () => {
    const html = render(
      <WellnessScores
        read={readFrom({ READINESS: ok({ score: 80, band: "green" }) })}
        isLoading={false}
        healthScore={null}
        healthPending
      />,
    );
    expect(html).toContain('data-slot="wellness-score-tile-skeleton"');
  });

  it("shows readiness, sleep score and Health score, in that order, and nothing else", () => {
    const html = render(
      <WellnessScores
        read={readFrom({
          READINESS: ok({ score: 82, band: "green", fresh: true }),
          SLEEP_SCORE: ok({ score: 55, band: "yellow" }),
          RECOVERY_SCORE: ok({ score: 70, band: "green" }),
          STRESS_SCORE: ok({ score: 30, band: "green" }),
          STRAIN_SCORE: ok({ score: 40, band: "yellow" }),
        })}
        isLoading={false}
        healthScore={report(81, "red")}
        healthPending={false}
      />,
    );
    const order = [...html.matchAll(/data-metric="([A-Z_]+)"/g)].map(
      (m) => m[1],
    );
    expect(order).toEqual(["READINESS", "SLEEP_SCORE", "HEALTH_SCORE"]);
    expect(html).toContain("wellness-tile");
    expect(html).toContain('data-band="green"');
    expect(html).toContain('href="/insights/scores/health"');
    expect(html).toContain('data-slot="wellness-score-band-word"');
  });

  it("gives a readiness from before today no number, no band and no word", () => {
    const html = render(
      <WellnessScores
        read={readFrom({
          READINESS: ok({
            score: 81,
            band: "green",
            fresh: false,
            asOfDay: "2026-11-24",
          }),
        })}
        isLoading={false}
        {...none}
      />,
    );
    const tile = html.slice(html.indexOf('data-metric="READINESS"'));
    expect(tile).toContain('data-provisional="true"');
    expect(tile).toContain('data-band="none"');
    expect(tile).not.toContain('data-slot="wellness-score-band-word"');
    expect(tile).not.toContain('data-slot="score-ring-provisional"');
    expect(tile).toContain('data-slot="wellness-score-note"');
    expect(tile).toMatch(/Last 81 on 11\/24/);
    // The last value is in the note, never in the ring's centre.
    expect(tile).not.toMatch(/tabular-nums[^>]*>81</);
  });

  it("keeps the Health score's safety line at rest", () => {
    const html = render(
      <WellnessScores
        read={readFrom({})}
        isLoading={false}
        healthScore={report(70, "yellow", [
          {
            id: "WELLBEING",
            result: { status: "insufficient", reason: "crisis_signposting" },
          },
        ] as unknown as HealthScoreReport["pillars"])}
        healthPending={false}
      />,
    );
    const tile = html.slice(html.indexOf('data-metric="HEALTH_SCORE"'));
    expect(tile).toContain('data-slot="wellness-score-note"');
    expect(tile).toContain("Safety guidance is shown instead of a score");
  });

  it("draws each tile's course under its band word, naming the window", () => {
    const html = render(
      <WellnessScores
        read={readFrom({
          READINESS: ok({ score: 70, band: "green", series: [60, 64, 70] }),
          SLEEP_SCORE: ok({ score: 30, band: "red", series: [] }),
        })}
        isLoading={false}
        {...none}
      />,
    );
    const readiness = html.slice(
      html.indexOf('data-metric="READINESS"'),
      html.indexOf('data-metric="SLEEP_SCORE"'),
    );
    expect(readiness).toContain('data-slot="wellness-score-history"');
    expect(readiness).toContain("30-day history");
    const sleep = html.slice(html.indexOf('data-metric="SLEEP_SCORE"'));
    expect(sleep).not.toContain('data-slot="wellness-score-history"');
  });
});
