import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import {
  INTEGER_VALUED_MEASUREMENT_TYPES,
  metricFractionDigits,
  DEFAULT_METRIC_FRACTION_DIGITS,
} from "@/lib/measurements/value-domain";
import type { CoachReadStripData } from "@/lib/insights/derived/coach-read-shape";

/**
 * GUARD — an integer-valued metric never renders a fractional part.
 *
 * The step sub-page read "MIN 104.0 steps" and "your usual range is
 * …–13,387.6 steps". Precision was a per-page prop defaulting to one
 * decimal: the pulse page remembered to pass 0, the step page did not, and
 * a tenth of a step was rendered. Every page remembering this individually
 * IS the defect — so the assertions below pin that the METRIC answers, and
 * that a page which passes nothing still renders a count as a count.
 *
 * Both surfaces on the reported card are covered: the Min/Max stat strip and
 * the coach-read strip underneath it.
 */

vi.mock("next/dynamic", () => ({
  default: () => {
    const Stub = () => <div data-slot="healthkit-chart-stub" />;
    Stub.displayName = "HealthChartStub";
    return Stub;
  },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/insights/steps",
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

// The coach-read strip paints nothing until it is client-mounted (React
// #418). Force the mounted branch so the band sentence reaches the markup.
vi.mock("@/hooks/use-mounted", () => ({ useMounted: () => true }));
// The chart is stubbed, so it never reports its window; settle the strip so
// it paints the summary this guard reads.
vi.mock("@/hooks/use-chart-domain-stats", () => ({
  useChartDomainStats: () => ({
    statsByType: null,
    statsSettled: true,
    onVisibleStats: () => {},
  }),
}));

const analyticsMock = vi.fn();
vi.mock("@/hooks/use-insights-analytics", () => ({
  useInsightsAnalytics: () => analyticsMock(),
}));

const coachReadMock = vi.fn();
vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return { ...actual, useQuery: () => coachReadMock() };
});

import { CoachReadStrip } from "../derived/coach-read-strip";
import InsightsStepsPage from "@/app/insights/steps/page";

function render(node: React.ReactNode, locale: "en" | "de" = "de") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLocale={locale}>{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

/** The band and the reading the reporter saw, to the digit. */
const REPORTED_BAND: CoachReadStripData = {
  learning: false,
  baseline: {
    low: 104,
    high: 13387.6,
    latest: 8213.4,
    placement: "within",
  },
  driver: null,
} as unknown as CoachReadStripData;

/**
 * A German-locale decimal on a count: "104,0", "13.387,6". The Latin-1
 * comma-decimal shape is what the reporter photographed.
 */
const FRACTIONAL_GERMAN = /\d,\d/;

beforeEach(() => {
  analyticsMock.mockReset();
  coachReadMock.mockReset();
});

describe("integer-metric precision guard", () => {
  it("resolves zero decimals for every discrete metric", () => {
    expect(INTEGER_VALUED_MEASUREMENT_TYPES.size).toBeGreaterThan(10);
    for (const type of INTEGER_VALUED_MEASUREMENT_TYPES) {
      expect(metricFractionDigits(type), type).toBe(0);
    }
    // A continuous metric keeps the shared default; an unknown one too.
    expect(metricFractionDigits("PULSE")).toBe(DEFAULT_METRIC_FRACTION_DIGITS);
    expect(metricFractionDigits("WEIGHT")).toBe(DEFAULT_METRIC_FRACTION_DIGITS);
    expect(metricFractionDigits(null)).toBe(DEFAULT_METRIC_FRACTION_DIGITS);
  });

  it("renders the coach-read band without a fractional step", () => {
    coachReadMock.mockReturnValue({ data: REPORTED_BAND });

    const html = render(
      <CoachReadStrip metricType="ACTIVITY_STEPS" unit="Schritte" />,
    );

    expect(html).toContain('data-slot="coach-read-baseline"');
    expect(html).not.toMatch(FRACTIONAL_GERMAN);
    // The band edges are still there, rounded to whole steps.
    expect(html).toContain("13.388");
    expect(html).toContain("104");
  });

  it("keeps the decimal for a metric that is not a count", () => {
    coachReadMock.mockReturnValue({
      data: {
        learning: false,
        baseline: { low: 71.4, high: 84.2, latest: 78.6, placement: "within" },
        driver: null,
      } as unknown as CoachReadStripData,
    });

    const html = render(<CoachReadStrip metricType="WEIGHT" unit="kg" />);
    expect(html).toMatch(FRACTIONAL_GERMAN);
  });

  it("renders the step page stat strip without a fractional step", () => {
    // The page passes no precision prop at all — that is the point.
    analyticsMock.mockReturnValue({
      data: {
        summaries: {
          ACTIVITY_STEPS: {
            count: 214,
            latest: 8213,
            min: 104,
            max: 11762,
            mean: 6431.72,
            median: 6802.5,
          },
        },
      },
      isEmpty: false,
      isLoading: false,
    });
    coachReadMock.mockReturnValue({ data: undefined });

    const html = render(<InsightsStepsPage />);

    expect(html).toContain('data-slot="metric-stat-strip"');
    expect(html).not.toMatch(FRACTIONAL_GERMAN);
    // The numbers themselves survive, thousands-grouped and whole.
    expect(html).toContain("11.762");
    expect(html).toContain("104");
    // …and the unit reads in German, not as the English word. (The route
    // slug `/insights/steps` legitimately appears in the header links, so
    // match the unit in its rendered position: right after a number.)
    expect(html).toContain("104 Schritte");
    expect(html).not.toMatch(/\d\s*steps\b/);
  });
});
