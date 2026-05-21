import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * v1.4.43 W2-CHART-GATE — pin the empty-state copy split.
 *
 * Pre-v1.4.43 the chart painted "Erfasse mehr Messungen, um die
 * Trendlinie freizuschalten" whenever `chartData.length < 3` — but
 * `chartData` is daily-aggregated, so a user with many measurements
 * on < 3 distinct days saw the misleading "log more measurements"
 * hint despite having logged plenty. The gate now keys on the raw
 * measurement count surfaced via the `rawCount` property the
 * queryFn stashes on its return array. When `rawCount >= 3` the
 * "need more days" copy paints; otherwise the legacy "log more"
 * copy stays.
 */

function buildData(
  rows: Array<{ measuredAt: string; value: number; count?: number }>,
  rawCount: number,
): unknown[] {
  // Re-use the same array-with-stashed-property shape the real
  // queryFn produces. The chart's `useMemo(() => …, [data])` reads
  // `(data as ChartDataPoint[] & { rawCount?: number }).rawCount`.
  const points = rows.map((r) => ({
    date: r.measuredAt.slice(0, 10),
    timestamp: new Date(r.measuredAt).getTime(),
    PULSE: r.value,
  }));
  Object.defineProperty(points, "rawCount", {
    value: rawCount,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return points;
}

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    isAuthenticated: true,
    user: null,
    isLoading: false,
  }),
}));

describe("<HealthChart> — empty-state gate by raw count", () => {
  beforeEach(() => {
    vi.resetModules();
  });


  it("renders need-more-days copy when chartData.length < 3 but rawCount >= 3", async () => {
    // Two distinct days with 50 raw rows total — the daily-aggregated
    // chartData collapses to 2 points but the user logged plenty.
    const data = buildData(
      [
        { measuredAt: "2026-05-19T09:00:00.000Z", value: 70 },
        { measuredAt: "2026-05-20T09:00:00.000Z", value: 72 },
      ],
      50,
    );

    vi.doMock("@tanstack/react-query", () => ({
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
      <I18nProvider initialLocale="de">
        <HealthChart types={["PULSE"]} title="Pulse" unit="bpm" />
      </I18nProvider>,
    );

    expect(html).toContain("Mehr Messtage erforderlich");
    expect(html).not.toContain("Erfasse mindestens 3 Einträge");

    vi.doUnmock("@tanstack/react-query");
  });

  it("renders no-data copy when rawCount < 3", async () => {
    const data = buildData(
      [{ measuredAt: "2026-05-20T09:00:00.000Z", value: 70 }],
      1,
    );

    vi.doMock("@tanstack/react-query", () => ({
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
      <I18nProvider initialLocale="de">
        <HealthChart types={["PULSE"]} title="Pulse" unit="bpm" />
      </I18nProvider>,
    );

    expect(html).toContain("Erfasse mindestens 3 Einträge");
    expect(html).not.toContain("Mehr Messtage erforderlich");

    vi.doUnmock("@tanstack/react-query");
  });
});
