import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import type { DataSummary } from "@/lib/analytics/trends";

import { MetricStatStrip } from "../metric-stat-strip";

/**
 * v1.8.5 — `<MetricStatStrip>` SSR coverage.
 *
 * The strip leads the insights category pages with the four central
 * stats — min / max / median / mean — read from the already-fetched
 * `summaries` slice (zero new network). Acceptance:
 *   1. Renders four labelled cells: min, max, median, mean.
 *   2. Each cell shows the formatted value + the metric unit.
 *   3. A null summary (read in flight) renders nothing rather than a
 *      strip full of em-dashes.
 *   4. A zero-count summary renders nothing (brand-new metric, no data).
 */

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

const populated: DataSummary = {
  count: 42,
  latest: 72,
  min: 58,
  max: 88,
  mean: 70.4,
  median: 71,
  avg7: 71,
  avg30: 70,
  slope7: null,
  slope30: null,
  anomalyCount: 0,
  avg30LastMonth: null,
  avg30LastYear: null,
};

describe("<MetricStatStrip>", () => {
  it("renders the four stat cells with min / max / median / mean", () => {
    const html = render(<MetricStatStrip summary={populated} unit="bpm" />);
    expect(html).toContain('data-stat="min"');
    expect(html).toContain('data-stat="max"');
    expect(html).toContain('data-stat="median"');
    expect(html).toContain('data-stat="mean"');
  });

  it("shows the formatted values and the unit", () => {
    const html = render(<MetricStatStrip summary={populated} unit="bpm" />);
    expect(html).toContain("58");
    expect(html).toContain("88");
    expect(html).toContain("71");
    expect(html).toContain("bpm");
  });

  it("renders nothing while the summary is still loading", () => {
    const html = render(<MetricStatStrip summary={null} unit="bpm" />);
    expect(html).toBe("");
  });

  it("renders nothing for a zero-count metric", () => {
    const empty: DataSummary = { ...populated, count: 0 };
    const html = render(<MetricStatStrip summary={empty} unit="bpm" />);
    expect(html).toBe("");
  });

  it("renders the default 'Median' label when no override is given", () => {
    const html = render(<MetricStatStrip summary={populated} unit="bpm" />);
    expect(html).toContain("Median");
  });

  // v1.16.16 — the median cell follows the chart's active range, so the label
  // names the metric without asserting a fixed window it can't honor.
  it("renders an overridden median label when medianLabel is provided", () => {
    const html = render(
      <MetricStatStrip
        summary={populated}
        unit="mg/dL"
        medianLabel="Median glucose"
      />,
    );
    expect(html).toContain("Median glucose");
  });

  it("honours fractionDigits for integer-unit metrics (0 decimals)", () => {
    const html = render(
      <MetricStatStrip
        summary={{ ...populated, min: 100, max: 180, median: 126 }}
        unit="mg/dL"
        fractionDigits={0}
      />,
    );
    // No "100.0" — integer precision.
    expect(html).toContain("100\u00A0mg/dL");
    expect(html).not.toContain("100.0");
  });

  it("falls back to mean when median is absent (older payload)", () => {
    const noMedian: DataSummary = { ...populated, median: null };
    const html = render(<MetricStatStrip summary={noMedian} unit="bpm" />);
    // Median cell still paints (em-dash) so the four-up grid stays
    // balanced; min / max / mean keep their values.
    expect(html).toContain('data-stat="median"');
    expect(html).toContain('data-stat="mean"');
  });

  describe("multi-series mode (blood pressure — one card, two columns)", () => {
    const sys: DataSummary = { ...populated, min: 118, max: 142, median: 128 };
    const dia: DataSummary = { ...populated, min: 72, max: 91, median: 80 };

    it("renders ONE card with both series as side-by-side columns", () => {
      const html = render(
        <MetricStatStrip
          groupLabel="Blood pressure"
          series={[
            { dataKey: "sys", summary: sys, unit: "mmHg", seriesLabel: "Sys" },
            { dataKey: "dia", summary: dia, unit: "mmHg", seriesLabel: "Dia" },
          ]}
        />,
      );
      // Exactly one strip card, flagged multi-series.
      expect(html.match(/data-slot="metric-stat-strip"/g)?.length).toBe(1);
      expect(html).toContain('data-multi-series="true"');
      // Both series blocks present with their own data-series tokens.
      expect(html).toContain('data-series="sys"');
      expect(html).toContain('data-series="dia"');
      // Both headers + both values render in the single card.
      expect(html).toContain("Sys");
      expect(html).toContain("Dia");
      expect(html).toContain("118");
      expect(html).toContain("72");
    });

    it("still paints the populated half when one series has no data", () => {
      const html = render(
        <MetricStatStrip
          groupLabel="Blood pressure"
          series={[
            { dataKey: "sys", summary: sys, unit: "mmHg", seriesLabel: "Sys" },
            { dataKey: "dia", summary: null, unit: "mmHg", seriesLabel: "Dia" },
          ]}
        />,
      );
      // The populated half paints; the empty half self-gates to nothing
      // (no wrapper, no cells) so the card shows just the one column.
      expect(html).toContain('data-series="sys"');
      expect(html).not.toContain('data-series="dia"');
      expect(html).not.toContain("72");
    });

    it("renders nothing when every series is empty", () => {
      const html = render(
        <MetricStatStrip
          groupLabel="Blood pressure"
          series={[
            { dataKey: "sys", summary: null, unit: "mmHg" },
            { dataKey: "dia", summary: null, unit: "mmHg" },
          ]}
        />,
      );
      expect(html).toBe("");
    });

    it("reads the chart's visible-range stats over the full-range summary, with no pill", () => {
      const html = render(
        <MetricStatStrip
          groupLabel="Blood pressure"
          series={[
            {
              dataKey: "sys",
              summary: sys,
              unit: "mmHg",
              seriesLabel: "Sys",
              windowStats: {
                count: 5,
                min: 120,
                max: 130,
                median: 125,
                mean: 124,
              },
            },
            { dataKey: "dia", summary: dia, unit: "mmHg", seriesLabel: "Dia" },
          ]}
        />,
      );
      // The sys block flags windowed (visible-range stats present); dia does not.
      expect(html).toContain('data-series="sys" data-windowed="true"');
      // v1.12.8 — no "selected range" pill: the chart's range tab is the
      // single, visible selector for both chart and strip.
      expect(html).not.toContain('data-slot="metric-stat-window-badge"');
      // Visible-range numbers win over the full-range summary for sys.
      expect(html).toContain("120");
    });
  });
});

describe("<MetricStatStrip> waits for the chart's window", () => {
  // The chart opens on a 30-day window. Painting the all-time summary until
  // the chart reports, then swapping to the window, made every number jump
  // a beat after the page loaded.
  it("holds the cells while the chart's window is still pending", () => {
    const html = render(
      <MetricStatStrip summary={populated} unit="bpm" windowPending />,
    );
    expect(html).toContain('data-stat="min"');
    expect(html).toContain('data-window-pending="true"');
    expect(html).not.toContain("58.0\u00A0bpm");
    expect(html).not.toContain("88.0\u00A0bpm");
  });

  it("paints the window's numbers once the chart reported", () => {
    const html = render(
      <MetricStatStrip
        summary={populated}
        unit="bpm"
        windowStats={{ count: 5, min: 60, max: 80, median: 70, mean: 70 }}
      />,
    );
    expect(html).toContain("60.0\u00A0bpm");
    expect(html).not.toContain("58.0\u00A0bpm");
  });
});

/**
 * With the day panel docked beside the blood-pressure page (1280 px and up)
 * each half of the card is a narrow column. A four-up row there left every
 * cell narrower than "112 mmHg": the systolic values broke onto two lines,
 * the two-digit diastolic ones did not. The pair is now unbreakable and the
 * cell grid steps by the series' own width, not the window's.
 */
describe("<MetricStatStrip> keeps a value and its unit on one line", () => {
  const sys: DataSummary = {
    ...populated,
    min: 104,
    max: 131,
    median: 112,
    mean: 112.4,
  };
  const dia: DataSummary = { ...populated, min: 66, max: 84, median: 74 };

  function bloodPressure(): string {
    return render(
      <MetricStatStrip
        groupLabel="Blood pressure"
        series={[
          {
            dataKey: "sys",
            summary: sys,
            unit: "mmHg",
            fractionDigits: 0,
            seriesLabel: "Systolic",
          },
          {
            dataKey: "dia",
            summary: dia,
            unit: "mmHg",
            fractionDigits: 0,
            seriesLabel: "Diastolic",
          },
        ]}
      />,
    );
  }

  /** The text of every value cell, in order. */
  function values(html: string): string[] {
    return [
      ...html.matchAll(
        /data-stat="[a-z]+"[^>]*><p[^>]*>[^<]*<\/p><p[^>]*>([^<]*)<\/p>/g,
      ),
    ].map((m) => m[1]!);
  }

  it("joins every value to its unit with a no-break space", () => {
    const cells = values(bloodPressure());
    expect(cells).toEqual([
      "104\u00A0mmHg",
      "131\u00A0mmHg",
      "112\u00A0mmHg",
      "112\u00A0mmHg",
      "66\u00A0mmHg",
      "84\u00A0mmHg",
      "74\u00A0mmHg",
      "70\u00A0mmHg",
    ]);
    // No ordinary space is left for the line to break at.
    for (const cell of cells) expect(cell).not.toMatch(/ /);
  });

  it("writes a value without a unit as the number alone", () => {
    const html = render(<MetricStatStrip summary={populated} unit="" />);
    for (const cell of values(html)) expect(cell).not.toMatch(/\s$/);
  });

  it("steps the cells of a half-card column by the column's width, not the window's", () => {
    const html = bloodPressure();
    const series = [
      ...html.matchAll(/data-slot="metric-stat-series"[^>]*>/g),
    ].map((m) => m[0]);
    expect(series).toHaveLength(2);
    for (const tag of series) {
      expect(tag).toContain('data-layout="column"');
      expect(tag).toContain("@container/stat-series");
    }
    // Two by two in a narrow column, four up only from 28rem of its own.
    expect(html.match(/@md\/stat-series:grid-cols-4/g)).toHaveLength(2);
    expect(html).not.toMatch(/(^|[\s"])sm:grid-cols-4/);
  });

  it("steps a full-width strip from 36rem, the width its old window step gave it", () => {
    const html = render(<MetricStatStrip summary={populated} unit="bpm" />);
    expect(html).toContain('data-layout="full"');
    expect(html).toContain("@xl/stat-series:grid-cols-4");
    expect(html).not.toMatch(/(^|[\s"])sm:grid-cols-4/);
  });
});
