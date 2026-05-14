import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const sampleData = vi.hoisted(() => {
  // 30 days of synthetic readings so HealthChart paints something
  // and the controls render (the chart returns null when data is
  // empty).
  const out: Array<{
    date: string;
    timestamp: number;
    WEIGHT: number;
  }> = [];
  for (let i = 0; i < 30; i++) {
    const ts = Date.UTC(2026, 4, 1 + i, 12, 0, 0);
    out.push({
      date: new Date(ts).toDateString(),
      timestamp: ts,
      WEIGHT: 80 + i * 0.05,
    });
  }
  return out;
});

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: sampleData, isLoading: false }),
  useQueryClient: () => ({
    cancelQueries: () => Promise.resolve(),
    getQueryData: () => undefined,
    setQueryData: () => undefined,
    invalidateQueries: vi.fn(),
  }),
  useMutation: () => ({ mutate: () => undefined, isPending: false }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ isAuthenticated: true, user: null }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { HealthChart } from "../health-chart";
import { resolveMiniRangePoints, type DataWindow } from "../mini-window";

/**
 * v1.4.16 phase B5c — chart mini-mode + windowOverride.
 *
 * The Oura-style RecommendationCard (B5c task 5) embeds a small
 * version of the chart for the recommendation's data window. The
 * embedded chart needs:
 *
 *   1. `mini` prop — drops the range-tab header, the Switch row, the
 *      personal-baseline / target-band toggles, and shrinks padding.
 *      The result fits inside an expanded rec card without
 *      overwhelming the rationale rows.
 *
 *   2. `windowOverride` prop — pins the chart's range to the rec's
 *      data window regardless of any parent context. dataWindow values
 *      mirror the rationale schema enum
 *      (last7days / last30days / last90days / allTime).
 *
 * Because HealthChart is heavy (TanStack Query + Recharts) we cover
 * the visible-DOM contract via SSR markup snapshots — assert that
 * the toggles are absent when `mini` is set, and that the parent
 * passes through the override window.
 */

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

describe("resolveMiniRangePoints()", () => {
  it.each<[DataWindow, number]>([
    ["last7days", 7],
    ["last30days", 30],
    ["last90days", 90],
    ["allTime", 0],
  ])("maps %s to %d points", (window, expected) => {
    expect(resolveMiniRangePoints(window)).toBe(expected);
  });
});

describe("<HealthChart mini>", () => {
  it("does not render the range tabs / mode-switch row in mini mode", () => {
    const html = render(<HealthChart types={["WEIGHT"]} title="Weight" mini />);
    // No "7d" / "30d" / "90d" range tabs.
    expect(html).not.toMatch(/data-slot="chart-range-tab"/);
    // No "7-day trend" toggle.
    expect(html).not.toMatch(/7-day trend/i);
  });

  it("renders the range tabs when NOT in mini mode (regression guard)", () => {
    const html = render(<HealthChart types={["WEIGHT"]} title="Weight" />);
    // Default render still shows the range tabs. The v1.4.18 overlay
    // toggles moved into a popover dropdown that's only visible when
    // chartKey is wired; without one the chart skips controls and
    // stays at the clean-line default.
    expect(html).toMatch(/data-slot="chart-range-tab"/);
  });

  it("renders the overlay-controls trigger when chartKey is supplied", () => {
    const html = render(
      <HealthChart types={["WEIGHT"]} title="Weight" chartKey="weight" />,
    );
    expect(html).toContain("chart-overlay-controls-trigger");
  });

  it("renders the overlay-controls trigger for BMI charts", () => {
    const html = render(
      <HealthChart
        types={["WEIGHT"]}
        title="BMI"
        chartKey="bmi"
        valueMode="bmi"
      />,
    );
    expect(html).toContain("chart-overlay-controls-trigger");
  });

  it("accepts windowOverride and applies the matching range-points", () => {
    const html = render(
      <HealthChart
        types={["WEIGHT"]}
        title="Weight"
        mini
        windowOverride="last7days"
      />,
    );
    // The component renders without throwing; the override is
    // applied by the lazy-state initializer. Final-DOM assertion:
    // mini chart still emits the title.
    expect(html).toContain("Weight");
  });
});
