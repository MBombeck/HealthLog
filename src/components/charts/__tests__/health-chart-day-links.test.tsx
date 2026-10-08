import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import enMessages from "../../../../messages/en.json";

/**
 * v1.42 — the chart as a door to its days, and where it is NOT one.
 *
 * A metric sub-page (`dayLinks`) gets the plot click, the caption saying so,
 * the row of day dots and a day link in every daily row of its data table.
 * A tile's mini chart and every mount that does not ask (the dashboard) get
 * none of it: too small to hit, and the tile has its own destination.
 */

function series(count: number) {
  const base = Date.now() - 12 * 3_600_000;
  return Array.from({ length: count }, (_, i) => ({
    date: `p${i}`,
    timestamp: base - (count - 1 - i) * 86_400_000,
    PULSE: 60 + i,
  }));
}

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ isAuthenticated: true, user: null, isLoading: false }),
}));

async function renderChart(extraProps: Record<string, unknown>) {
  vi.doMock("@tanstack/react-query", () => ({
    keepPreviousData: (previous: unknown) => previous,
    useQuery: () => ({ data: series(10), isLoading: false }),
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

describe("<HealthChart> day links", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("a metric page's chart opens its days: plot, caption and table", async () => {
    const html = await renderChart({ dayLinks: true, showDataTable: true });
    expect(html).toContain('data-day-links="true"');
    expect(html).toContain('data-slot="chart-day-caption"');
    expect(html).toContain("Click a point to open its day.");
    const links = html.match(/data-slot="day-link"/g) ?? [];
    expect(links).toHaveLength(10);
    expect(html).toMatch(/href="[^"]*\?day=\d{4}-\d{2}-\d{2}"/);
  });

  it("a chart that does not ask stays a chart", async () => {
    const html = await renderChart({ showDataTable: true });
    expect(html).not.toContain('data-day-links="true"');
    expect(html).not.toContain('data-slot="chart-day-caption"');
    expect(html).not.toContain('data-slot="day-link"');
  });

  it("a mini chart in a tile never opens a day, even when asked", async () => {
    const html = await renderChart({ dayLinks: true, mini: true });
    expect(html).not.toContain('data-day-links="true"');
    expect(html).not.toContain('data-slot="chart-day-caption"');
    expect(html).not.toContain('data-slot="day-link"');
  });
});
