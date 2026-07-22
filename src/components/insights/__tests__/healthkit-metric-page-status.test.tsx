import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import type { InsightStatusData } from "@/hooks/use-insight-status";

/**
 * v1.8.7.1 — `<HealthKitMetricPage statusMetric=…>` mounts the generic
 * per-metric assessment card beneath the chart when the metric has data,
 * and falls back to the existing insufficient-data empty state otherwise.
 *
 * The page leans on several hooks (`useAuth`, `useInsightsAnalytics`,
 * `useInsightMetricStatus`, …); the test mocks them so the data /
 * empty branch is deterministic. The chart is `next/dynamic`-imported,
 * so SSR renders its stub — enough to verify the assessment slot.
 */

vi.mock("next/dynamic", () => ({
  default: () => {
    const Stub = () => <div data-slot="healthkit-chart-stub" />;
    Stub.displayName = "HealthChartStub";
    return Stub;
  },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/insights/body-temperature",
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { timezone: "UTC", dateOfBirth: null, gender: null },
    isAuthenticated: true,
  }),
}));

vi.mock("@/hooks/use-insights-layout-prefs", () => ({
  useInsightsLayoutPrefs: () => ({ layout: null, compareBaseline: false }),
}));

const analyticsMock = vi.fn();
vi.mock("@/hooks/use-insights-analytics", () => ({
  useInsightsAnalytics: () => analyticsMock(),
}));

const metricStatusMock = vi.fn();
vi.mock("@/hooks/use-insight-status", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/hooks/use-insight-status")>();
  return {
    ...actual,
    useInsightMetricStatus: (...args: unknown[]) => metricStatusMock(...args),
  };
});

import { HealthKitMetricPage } from "../healthkit-metric-page";
import { METRIC_STATUS_IDS } from "@/lib/insights/metric-status-registry";
import InsightsActiveEnergyPage from "@/app/insights/active-energy/page";

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLocale={locale}>{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

const baseProps = {
  measurementType: "HEART_RATE_VARIABILITY",
  insightMetric: "HEART_RATE_VARIABILITY" as const,
  chartKey: "hrv" as const,
  i18nPrefix: "insights.hrv",
  color: "var(--chart-1)" as const,
  unit: "ms",
  emptyStateIcon: null,
};

const settledStatus: InsightStatusData = {
  hasProvider: true,
  text: "Your HRV has trended upward over the last month.",
  cached: false,
  updatedAt: null,
};

beforeEach(() => {
  analyticsMock.mockReset();
  metricStatusMock.mockReset();
});

describe("<HealthKitMetricPage> status mount", () => {
  it("mounts the assessment card when statusMetric is set and the metric has data", () => {
    analyticsMock.mockReturnValue({
      data: { summaries: { HEART_RATE_VARIABILITY: { count: 12 } } },
      isEmpty: false,
    });
    metricStatusMock.mockReturnValue({
      data: settledStatus,
      isLoading: false,
    });

    const html = render(
      <HealthKitMetricPage
        {...baseProps}
        statusMetric="HEART_RATE_VARIABILITY"
      />,
    );

    // The server pass renders the card's loading skeleton even when the
    // mocked query reports settled data: `<MetricStatusCard>` pins SSR +
    // the hydration render to the loading branch (`!mounted`) so a query
    // that settles before a late-hydrating boundary replays its first
    // render cannot mismatch the server HTML (React #418). The settled
    // text swaps in on the first client re-render.
    expect(html).toContain('data-testid="insight-status-card-loading"');
    expect(html).not.toContain("Your HRV has trended upward");
    // The card fetch is enabled (statusMetric present + data present).
    expect(metricStatusMock).toHaveBeenCalledWith(
      "HEART_RATE_VARIABILITY",
      true,
    );
  });

  it("exposes the manual capture type on the populated branch", () => {
    analyticsMock.mockReturnValue({
      data: { summaries: { HEART_RATE_VARIABILITY: { count: 12 } } },
      isEmpty: false,
    });
    metricStatusMock.mockReturnValue({ data: undefined, isLoading: false });

    const html = render(
      <HealthKitMetricPage
        {...baseProps}
        emptyStateCtaType={null}
        captureType="BODY_TEMPERATURE"
      />,
    );

    expect(html).toContain('data-slot="metric-add-reading"');
    expect(html).toContain(
      "/measurements?add=BODY_TEMPERATURE&amp;returnTo=%2Finsights%2Fbody-temperature",
    );
  });

  it("does not expose capture for a populated device-only metric", () => {
    analyticsMock.mockReturnValue({
      data: { summaries: { HEART_RATE_VARIABILITY: { count: 12 } } },
      isEmpty: false,
    });
    metricStatusMock.mockReturnValue({ data: undefined, isLoading: false });

    const html = render(
      <HealthKitMetricPage {...baseProps} emptyStateCtaType={null} />,
    );

    expect(html).not.toContain('data-slot="metric-add-reading"');
  });

  it("does not mount the assessment card when statusMetric is omitted", () => {
    analyticsMock.mockReturnValue({
      data: { summaries: { HEART_RATE_VARIABILITY: { count: 12 } } },
      isEmpty: false,
    });
    metricStatusMock.mockReturnValue({ data: undefined, isLoading: false });

    const html = render(<HealthKitMetricPage {...baseProps} />);

    // No assessment heading, and the card (which owns the hook) never
    // mounts, so the generic fetch is never wired.
    expect(html).not.toContain("Assessment");
    expect(metricStatusMock).not.toHaveBeenCalled();
  });

  it("renders the insufficient-data empty state (no card) when the metric has no data", () => {
    analyticsMock.mockReturnValue({ data: null, isEmpty: true });
    metricStatusMock.mockReturnValue({ data: undefined, isLoading: false });

    const html = render(
      <HealthKitMetricPage
        {...baseProps}
        statusMetric="HEART_RATE_VARIABILITY"
      />,
    );

    // Empty branch: the page short-circuits to the empty state before the
    // card JSX, so no settled assessment text and the card (and its fetch)
    // never mounts — a source-less account never fires the round-trip.
    expect(html).not.toContain("Your HRV has trended upward");
    expect(metricStatusMock).not.toHaveBeenCalled();
  });

  it("renders the loading skeleton while the analytics read is in flight", () => {
    analyticsMock.mockReturnValue({
      data: undefined,
      isEmpty: false,
      isLoading: true,
    });
    metricStatusMock.mockReturnValue({ data: undefined, isLoading: false });

    const html = render(
      <HealthKitMetricPage
        {...baseProps}
        statusMetric="HEART_RATE_VARIABILITY"
      />,
    );

    // Stat-strip skeleton + chart skeleton paint; the assessment card never
    // mounts in flight.
    expect(html).toContain('data-slot="metric-stat-strip-skeleton"');
    expect(html).toContain('data-slot="chart-skeleton"');
    expect(metricStatusMock).not.toHaveBeenCalled();
  });

  it("renders an error message + retry control when the analytics read fails", () => {
    const refetch = vi.fn();
    analyticsMock.mockReturnValue({
      data: undefined,
      isEmpty: false,
      isLoading: false,
      error: new Error("boom"),
      refetch,
    });
    metricStatusMock.mockReturnValue({ data: undefined, isLoading: false });

    const html = render(
      <HealthKitMetricPage
        {...baseProps}
        statusMetric="HEART_RATE_VARIABILITY"
      />,
    );

    expect(html).toContain('data-slot="healthkit-metric-error"');
    expect(html).toContain('data-slot="healthkit-metric-retry"');
    expect(html).toContain('role="alert"');
    // The error branch wins over the data / empty branches, so the
    // assessment fetch never fires.
    expect(metricStatusMock).not.toHaveBeenCalled();
  });

  it("wires the active-energy page to an accepted registry id (not the MeasurementType remap)", () => {
    // v1.8.7.1 (Design H1) — the active-energy page formerly passed
    // `ACTIVE_ENERGY_BURNED` (the DB MeasurementType), which the route's
    // closed enum rejects with 422; the registry id is `ACTIVE_ENERGY`.
    // Render the real page module and assert the hook receives a metric id
    // the route accepts.
    analyticsMock.mockReturnValue({
      data: { summaries: { ACTIVE_ENERGY_BURNED: { count: 30 } } },
      isEmpty: false,
    });
    metricStatusMock.mockReturnValue({ data: undefined, isLoading: false });

    render(<InsightsActiveEnergyPage />);

    expect(metricStatusMock).toHaveBeenCalled();
    const passedMetric = metricStatusMock.mock.calls[0][0] as string;
    expect(passedMetric).toBe("ACTIVE_ENERGY");
    expect(METRIC_STATUS_IDS).toContain(passedMetric);
  });
});
