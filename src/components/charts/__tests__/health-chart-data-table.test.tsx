import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import enMessages from "../../../../messages/en.json";

/**
 * The table under the chart must show what the chart drew.
 *
 * These render the real `<HealthChart>` so the table is fed by the component's
 * own resolution path — the range slice, the bucketing, the row order — rather
 * than by a fixture handed straight to the table. If the chart's points and the
 * table's rows can ever diverge, that is the failure this catches.
 */

/**
 * `spacingDays` apart, ENDING half a day before now. The range tabs are
 * calendar-day windows anchored on now (v1.37.29), so an absolute-dated
 * fixture would age out of the window and exercise the empty state
 * instead of the table. The half-day offset keeps every point clear of
 * the exact window-boundary instant.
 */
function series(count: number, spacingDays = 1) {
  const base = Date.now() - 12 * 3_600_000;
  return Array.from({ length: count }, (_, i) => ({
    date: `p${i}`,
    timestamp: base - (count - 1 - i) * spacingDays * 86_400_000,
    PULSE: 60 + i,
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
    // `health-chart` imports `keepPreviousData` for its placeholder option;
    // the identity stand-in keeps the module-level destructure satisfied.
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
      <HealthChart types={["PULSE"]} title="Pulse" unit="bpm" {...extraProps} />
    </I18nProvider>,
  );
  vi.doUnmock("@tanstack/react-query");
  return html;
}

function rowCount(html: string): number {
  return (html.match(/data-slot="chart-data-table-row"/g) ?? []).length;
}

// The chart pulls in Recharts and the chart kit. Transforming that graph cold
// takes seconds on a loaded machine, so it happens once here, on a hook's
// budget, instead of inside whichever test happens to run first.
beforeAll(async () => {
  await import("../health-chart");
}, 60_000);

describe("<HealthChart> — data table", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("does not render a table unless the mount asks for one", async () => {
    const html = await renderChart(series(10));
    expect(html).not.toContain('data-slot="chart-data-table"');
  });

  it("renders one row per drawn point when the mount opts in", async () => {
    const html = await renderChart(series(10), { showDataTable: true });
    expect(html).toContain('data-slot="chart-data-table"');
    expect(rowCount(html)).toBe(10);
    expect(html).toContain("Data points (10)");
  });

  it("prints the drawn values through the chart's own tooltip formatter", async () => {
    const html = await renderChart(series(3), { showDataTable: true });
    // One decimal, the same `formatTooltipValue` the hover read-out uses.
    expect(html).toContain(">60.0<");
    expect(html).toContain(">61.0<");
    expect(html).toContain(">62.0<");
  });

  // The overlays are drawn FROM the points, not measured. A table of "the data
  // points behind the chart" that carried them would claim more than the chart
  // recorded.
  it("carries no column for the derived overlay series", async () => {
    const html = await renderChart(series(10), {
      showDataTable: true,
      chartKey: "pulse",
    });
    expect(html).not.toContain("PULSE_ma");
    expect(html).not.toContain("PULSE_trend");
    expect(html).not.toContain("PULSE_compare");
    // Exactly two column headers: the date and the one series.
    const headers = html.match(/scope="col"/g) ?? [];
    expect(headers).toHaveLength(2);
  });

  it("honours the visible range rather than the whole fetched series", async () => {
    // 40 daily points fetched, the default range tab windows to the last
    // 30 calendar days — the 30 points inside the window survive, the 10
    // older ones do not.
    const html = await renderChart(series(40), { showDataTable: true });
    expect(rowCount(html)).toBe(30);
    expect(html).toContain("Data points (30)");
  });

  it("captions a bucketed range as an average instead of implying daily readings", async () => {
    // 30 points four days apart span 116 days on the All range, so the
    // chart buckets to ISO weeks and several points share a bucket. The
    // rows are weekly means and the caption has to say so. (The 7/30/90
    // tabs are day windows now, so only "All" can span past 90 days.)
    const html = await renderChart(series(30, 4), {
      showDataTable: true,
      windowOverride: "allTime",
    });
    expect(html).toContain("One row per week of");
    expect(html).toContain("the average of that week");
    expect(html).not.toContain("One row per day of");
    // Weekly buckets collapse the 30 daily points into fewer rows.
    expect(rowCount(html)).toBeLessThan(30);
    expect(rowCount(html)).toBeGreaterThan(0);
  });

  it("shows no table at all when the window holds nothing", async () => {
    const html = await renderChart([], { showDataTable: true });
    expect(html).not.toContain('data-slot="chart-data-table"');
  });

  it("stays off a mini chart even when the prop is set", async () => {
    const html = await renderChart(series(10), {
      showDataTable: true,
      mini: true,
    });
    expect(html).not.toContain('data-slot="chart-data-table"');
  });
});
