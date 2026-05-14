import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import type { DataSummary } from "@/lib/analytics/trends";

/**
 * v1.4.25 W16a — `<Vo2MaxChartRow>` SSR coverage.
 *
 * Acceptance:
 *   1. Stat strip renders four data-slot cells: latest, min, max, avg30.
 *   2. When `summary.count === 0`, the chart is replaced by the empty-state
 *      hint; the stat strip remains so a brand-new account still gets a
 *      consistent shell.
 *   3. With a populated summary, the dynamic chart stub mounts (we mock
 *      `next/dynamic` so the Recharts dependency doesn't pull in DOM
 *      APIs unavailable in jsdom-less SSR).
 *   4. Compare-delta caption only renders when `compareBaseline` is set
 *      AND the summary carries `avg30LastMonth` / `avg30LastYear` data.
 */

vi.mock("next/dynamic", () => ({
  default: () => {
    const Stub = () => <div data-slot="health-chart-stub">chart</div>;
    Stub.displayName = "HealthChartStub";
    return Stub;
  },
}));

import { Vo2MaxChartRow } from "../vo2-max-chart-row";

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

const populatedSummary: DataSummary = {
  count: 12,
  latest: 42.3,
  min: 38.1,
  max: 45.7,
  mean: 41.5,
  avg7: 42.0,
  avg30: 41.8,
  slope7: null,
  slope30: { direction: "up", slope: 0.05, confidence: 0.42 },
  slope90: null,
  anomalyCount: 0,
  avg30LastMonth: 40.4,
  avg30LastYear: null,
};

const emptySummary: DataSummary = {
  count: 0,
  latest: null,
  min: null,
  max: null,
  mean: null,
  avg7: null,
  avg30: null,
  slope7: null,
  slope30: null,
  slope90: null,
  anomalyCount: 0,
  avg30LastMonth: null,
  avg30LastYear: null,
};

describe("<Vo2MaxChartRow>", () => {
  it("renders the four stat cells regardless of data state", () => {
    const html = render(<Vo2MaxChartRow summary={populatedSummary} />);
    expect(html).toContain('data-stat="latest"');
    expect(html).toContain('data-stat="min"');
    expect(html).toContain('data-stat="max"');
    expect(html).toContain('data-stat="avg30"');
  });

  it("mounts the chart stub when the summary carries data", () => {
    const html = render(<Vo2MaxChartRow summary={populatedSummary} />);
    expect(html).toContain('data-slot="health-chart-stub"');
    // The empty-state hint must NOT appear when the chart is mounted.
    expect(html).not.toContain('data-slot="vo2-chart-row-empty"');
  });

  it("falls back to the empty-state hint when count is zero", () => {
    const html = render(<Vo2MaxChartRow summary={emptySummary} />);
    expect(html).toContain('data-slot="vo2-chart-row-empty"');
    expect(html).not.toContain('data-slot="health-chart-stub"');
    // Stat strip stays mounted with em-dashes for the empty values.
    expect(html).toContain('data-stat="latest"');
  });

  it("renders no compare-delta caption when comparison is off", () => {
    const html = render(<Vo2MaxChartRow summary={populatedSummary} />);
    expect(html).not.toContain('data-slot="vo2-compare-delta"');
  });

  it("renders a compare-delta caption when comparison is on and data exists", () => {
    const html = render(
      <Vo2MaxChartRow
        summary={populatedSummary}
        compareBaseline="lastMonth"
      />,
    );
    expect(html).toContain('data-slot="vo2-compare-delta"');
    expect(html).toContain('data-compare-baseline="lastMonth"');
  });

  it("suppresses the compare-delta caption when the prior-period bucket is empty", () => {
    const html = render(
      <Vo2MaxChartRow
        summary={populatedSummary}
        compareBaseline="lastYear"
      />,
    );
    // avg30LastYear is null in the fixture, so the delta caption stays
    // suppressed even though comparison is enabled.
    expect(html).not.toContain('data-slot="vo2-compare-delta"');
  });

  it("renders the German labels under the de locale", () => {
    const html = render(<Vo2MaxChartRow summary={emptySummary} />, "de");
    expect(html).toContain("Aktuell");
    expect(html).toMatch(/Apple Health/i);
  });
});
