import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { makeBucketLabelFormatters } from "@/lib/charts/bucket-label";

import type { ChartDataPoint } from "../health-chart/types";

import enMessages from "../../../../messages/en.json";

/**
 * The 90-day tab draws weekly means: the chart, the caption chip and the data
 * table read the same grain, and a week cut by the window or still running is
 * labelled with the days it actually covers.
 *
 * The clock is pinned to Wednesday 18 November 2026, 10:00 UTC (11:00 in
 * Berlin, the chart's default zone). The 90-day cutoff is then 20 August
 * 10:00 UTC, so the window opens on Thursday 20 August and the newest week
 * is Monday 16 to Wednesday 18 November.
 */
const NOW = new Date("2026-11-18T10:00:00.000Z");
const DAY = 86_400_000;
const fmt = makeBucketLabelFormatters("en", "AUTO");
const label = (iso: string) => fmt.date(new Date(`${iso}T00:00:00.000Z`));

/** One point a day at the chart's noon-UTC day encoding, newest today. */
function dailySeries(days: number, readingsPerDay = 2) {
  const today = Date.UTC(2026, 10, 18, 12);
  return Array.from({ length: days }, (_, i) => ({
    date: `d${i}`,
    timestamp: today - (days - 1 - i) * DAY,
    PULSE: 60,
    PULSE__readings: readingsPerDay,
  }));
}

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ isAuthenticated: true, user: null, isLoading: false }),
}));

async function renderChart(
  data: unknown[],
  extraProps: Record<string, unknown> = {},
) {
  vi.doMock("@tanstack/react-query", () => ({
    keepPreviousData: (previous: unknown) => previous,
    useQuery: () => ({ data, isLoading: false }),
    useQueryClient: () => ({
      cancelQueries: () => Promise.resolve(),
      getQueryData: () => undefined,
      setQueryData: () => undefined,
      invalidateQueries: () => Promise.resolve(),
    }),
    useMutation: () => ({ mutate: () => undefined, isPending: false }),
  }));
  const { I18nProvider } = await import("@/lib/i18n/context");
  const { HealthChart } = await import("../health-chart");
  const html = renderToStaticMarkup(
    <I18nProvider initialLocale="en" initialMessages={enMessages}>
      <HealthChart
        types={["PULSE"]}
        title="Pulse"
        unit="bpm"
        showDataTable
        {...extraProps}
      />
    </I18nProvider>,
  );
  vi.doUnmock("@tanstack/react-query");
  return html;
}

function rowHeaders(html: string): string[] {
  return [
    ...html.matchAll(
      /data-slot="chart-data-table-row"[^>]*>\s*<th[^>]*>([^<]*)<\/th>/g,
    ),
  ].map((m) => m[1]);
}

describe("<HealthChart> on the 90-day tab", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("draws weekly means and says so on the chip, the plot and the table", async () => {
    const html = await renderChart(dailySeries(120), {
      windowOverride: "last90days",
    });
    expect(html).toContain('data-bucket="week"');
    expect(html).toContain('data-slot="chart-bucket-caption"');
    expect(html).toContain("Weekly avg");
    expect(html).toContain("One row per week of");
    expect(html).not.toContain("One row per day of");
    // 20 August to 18 November touches 14 ISO weeks.
    expect(rowHeaders(html)).toHaveLength(14);
    expect(html).toContain('data-bucket="week"');
  });

  it("labels the week still running and the week the window opens in by their days", async () => {
    const html = await renderChart(dailySeries(120), {
      windowOverride: "last90days",
    });
    const headers = rowHeaders(html);
    // Newest first.
    expect(headers[0]).toBe(`${label("2026-11-16")}–${label("2026-11-18")}`);
    expect(headers[1]).toBe(`${label("2026-11-09")}–${label("2026-11-15")}`);
    expect(headers.at(-1)).toBe(
      `${label("2026-08-20")}–${label("2026-08-23")}`,
    );
  });

  it("counts the readings behind each week", async () => {
    const html = await renderChart(dailySeries(120, 2), {
      windowOverride: "last90days",
    });
    expect(html).toContain('data-slot="chart-data-table-readings-head"');
    const counts = [
      ...html.matchAll(/data-slot="chart-data-table-readings"[^>]*>(\d+)</g),
    ].map((m) => Number(m[1]));
    // Three days so far this week, seven in a full week, four in the
    // week the window opens in (Thursday to Sunday), two readings a day.
    expect(counts[0]).toBe(6);
    expect(counts[1]).toBe(14);
    expect(counts.at(-1)).toBe(8);
  });

  it("keeps the 30-day tab daily, with no count column", async () => {
    const html = await renderChart(dailySeries(120), {
      windowOverride: "last30days",
    });
    expect(html).toContain('data-bucket="day"');
    expect(html).not.toContain('data-slot="chart-bucket-caption"');
    expect(html).not.toContain('data-slot="chart-data-table-readings-head"');
    expect(html).toContain("One row per day of");
  });

  it("does not call ten days that fold into two weeks sparse", async () => {
    const html = await renderChart(dailySeries(10), {
      windowOverride: "last90days",
    });
    expect(rowHeaders(html)).toHaveLength(2);
    expect(html).not.toContain('data-slot="chart-sparse-caption"');
  });
});

/**
 * The overlays on weekly points, read straight off the view hook: the 7-day
 * average is not drawn, the range band becomes the week's spread, the prior
 * period is the shifted week's mean, and the stat strip still reads days.
 */
describe("useHealthChartView on weekly points", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function view(
    rangePoints: 30 | 90,
    data: ChartDataPoint[],
    compare: "none" | "lastMonth" = "none",
  ) {
    const { useHealthChartView } =
      await import("../health-chart/use-health-chart-view");
    let out: ReturnType<typeof useHealthChartView> | undefined;
    function Probe() {
      out = useHealthChartView({
        data,
        rangePoints,
        types: ["PULSE"],
        userTimezone: "Europe/Berlin",
        tzFmt: fmt,
        showMA: true,
        showTrend: true,
        effectiveCompareBaseline: compare,
        mini: false,
        isLoading: false,
        isError: false,
      });
      return null;
    }
    renderToStaticMarkup(<Probe />);
    return out!;
  }

  it("draws no 7-day average over weeks, and keeps it over days", async () => {
    const weekly = await view(90, dailySeries(120));
    expect(weekly.activeBucket).toBe("week");
    expect(weekly.chartData?.some((p) => "PULSE_ma" in p)).toBe(false);
    expect(weekly.chartData?.some((p) => "PULSE_trend" in p)).toBe(true);
    const daily = await view(30, dailySeries(120));
    expect(daily.activeBucket).toBe("day");
    expect(daily.chartData?.some((p) => "PULSE_ma" in p)).toBe(true);
  });

  it("spans the range band over the week's days", async () => {
    const data = dailySeries(120).map((p, i) => ({
      ...p,
      PULSE__range: [50 + (i % 7), 70 + (i % 7)] as [number, number],
    }));
    const { chartData } = await view(90, data);
    const fullWeek = chartData![1];
    expect(fullWeek.PULSE__range).toEqual([50, 76]);
  });

  it("compares a week with the shifted week's mean, not with its Monday", async () => {
    // A value that climbs one per day: the shifted week's mean differs from
    // any single shifted day.
    const data = dailySeries(160).map((p, i) => ({ ...p, PULSE: i }));
    const { chartDataWithCompare } = await view(90, data, "lastMonth");
    const week = chartDataWithCompare![1];
    // The week's own mean minus 30 days of a +1-per-day climb.
    expect(week.PULSE_compare).toBeCloseTo((week.PULSE as number) - 30, 5);
  });

  it("reads the stat strip from the days, not from the weekly means", async () => {
    const data = dailySeries(120).map((p, i) => ({
      ...p,
      PULSE: 60 + (i % 7),
    }));
    const { visibleStatsByType } = await view(90, data);
    expect(visibleStatsByType?.PULSE.min).toBe(60);
    expect(visibleStatsByType?.PULSE.max).toBe(66);
  });
});
