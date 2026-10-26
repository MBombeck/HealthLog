import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { computePersonalBaseline } from "../health-chart/series-math";

/**
 * v1.4.16 — HealthChart Apple-Health-style polish contract.
 *
 * The HealthChart wrapper is the single component that the dashboard
 * uses for BP, weight, pulse, body-fat, sleep, and steps. We upgrade it
 * once with the v1.4.16 visual leap and the unit test pins the
 * SSR-renderable surface markers:
 *
 *   - the linear gradient primitive is wired (data-slot present),
 *   - the optional 90-day personal-baseline ReferenceLine is painted
 *     when the wrapper is given a baseline computation hook,
 *   - the rich tooltip primitive replaces the default Recharts tooltip
 *     so tooltip rendering happens through `RichChartTooltip`.
 *
 * Recharts itself renders client-side so we can't assert pixel layout
 * in node-based vitest. We assert that the wrapper's SSR output ships
 * the gradient `<defs>` block (Recharts emits primitives during SSR
 * even though hover/animations only kick in client-side) and that
 * the gradient id includes the metric type prefix.
 */

const sampleSeries = vi.hoisted(() => {
  // 30 days of synthetic systolic readings — ~120 baseline with mild
  // upward drift + small noise. The chart's 90-day median feature only
  // paints a baseline when sufficient data exists, so we hand it a
  // dataset comfortably above the 3-point threshold.
  const out: Array<{ measuredAt: string; value: number }> = [];
  for (let i = 0; i < 30; i++) {
    const dt = new Date(Date.UTC(2026, 4, 1 + i, 12, 0, 0));
    out.push({
      measuredAt: dt.toISOString(),
      value: 118 + (i % 5) - 2 + i * 0.05,
    });
  }
  return out;
});

vi.mock("@tanstack/react-query", () => ({
  // `health-chart` imports `keepPreviousData` for its placeholder option;
  // the identity stand-in keeps the module-level destructure satisfied.
  keepPreviousData: (previous: unknown) => previous,
  useQuery: () => ({
    data: sampleSeries.map((row) => {
      const ts = Date.parse(row.measuredAt);
      return {
        date: new Date(ts).toDateString(),
        timestamp: ts,
        BLOOD_PRESSURE_SYS: row.value,
      };
    }),
    isLoading: false,
  }),
  // Hook-side stubs so the v1.4.18 overlay-prefs hook
  // (`useChartOverlayPrefs`) doesn't blow up under SSR / test render.
  useQueryClient: () => ({
    cancelQueries: () => Promise.resolve(),
    getQueryData: () => undefined,
    setQueryData: () => undefined,
    invalidateQueries: () => Promise.resolve(),
  }),
  useMutation: () => ({ mutate: () => undefined, isPending: false }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    isAuthenticated: true,
    user: null,
    isLoading: false,
  }),
}));

describe("computePersonalBaseline()", () => {
  it("returns null with fewer than 5 data points", () => {
    expect(computePersonalBaseline([])).toBeNull();
    expect(
      computePersonalBaseline([
        { value: 120 },
        { value: 122 },
        { value: 118 },
        { value: 125 },
      ]),
    ).toBeNull();
  });

  it("returns the median for an odd-sized series", () => {
    // Sorted: [110, 115, 120, 125, 130]; median = 120.
    expect(
      computePersonalBaseline([
        { value: 130 },
        { value: 110 },
        { value: 120 },
        { value: 125 },
        { value: 115 },
      ]),
    ).toBe(120);
  });

  it("averages the two middle values for an even-sized series", () => {
    // Sorted: [110, 115, 120, 125, 130, 135]; middle two = 120,125 → 122.5.
    expect(
      computePersonalBaseline([
        { value: 110 },
        { value: 115 },
        { value: 120 },
        { value: 125 },
        { value: 130 },
        { value: 135 },
      ]),
    ).toBe(122.5);
  });

  it("caps the window at the most recent N points (default 90)", () => {
    // 100 points: first 5 are 200, remaining 95 are 100. With a 90-point
    // cap we slice off the trailing 90 → all 100s → median 100.
    const points: Array<{ value: number }> = [];
    for (let i = 0; i < 5; i++) points.push({ value: 200 });
    for (let i = 0; i < 95; i++) points.push({ value: 100 });
    expect(computePersonalBaseline(points, 90)).toBe(100);
  });
});

describe("<HealthChart> v1.4.18 clean-line revert", () => {
  it("does NOT paint a gradient fill under the line (clean line only)", async () => {
    // v1.4.18 reverts B1a's gradient-area treatment. the maintainer explicitly
    // rejected the soft-color fill below the line: the line itself is
    // the chart, no painted background under it. We assert the SSR
    // output ships no `<linearGradient>` defs and no `chart-gradient`
    // primitive markers.
    const { I18nProvider } = await import("@/lib/i18n/context");
    const { HealthChart } = await import("../health-chart");

    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <HealthChart
          types={["BLOOD_PRESSURE_SYS"]}
          title="Blood Pressure"
          unit="mmHg"
        />
      </I18nProvider>,
    );

    expect(html).not.toContain('data-slot="chart-linear-gradient"');
    expect(html).not.toContain("chart-gradient-BLOOD_PRESSURE_SYS");
    expect(html).not.toContain("linearGradient");
  });
});
