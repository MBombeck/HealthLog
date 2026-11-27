import { describe, it, beforeAll, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * v1.4.16 — HealthChart comparison overlay contract.
 *
 * Asserts the SSR-discoverable surface markers when a comparison
 * baseline is supplied:
 *
 *   - "chart-compare-caption" data-slot is rendered in the chart
 *     header so the user sees what overlay is active.
 *   - When data is sparse (no prior-period readings), the
 *     "chart-compare-unavailable" fallback caption shows instead.
 *
 * Recharts' actual SVG output is client-side only; the comparison
 * line render is exercised by the `chartDataWithCompare` memo logic
 * which we cover with the `comparison-shift.test.ts` unit tests.
 */

const sample30Days = vi.hoisted(() => {
  const out: Array<{ measuredAt: string; value: number }> = [];
  for (let i = 0; i < 30; i++) {
    const dt = new Date(Date.UTC(2026, 4, 1 + i, 12, 0, 0));
    out.push({
      measuredAt: dt.toISOString(),
      value: 120 + (i % 7),
    });
  }
  return out;
});

vi.mock("@tanstack/react-query", () => ({
  // `health-chart` imports `keepPreviousData` for its placeholder option;
  // the identity stand-in keeps the module-level destructure satisfied.
  keepPreviousData: (previous: unknown) => previous,
  useQuery: () => ({
    data: sample30Days.map((row) => {
      const ts = Date.parse(row.measuredAt);
      return {
        date: new Date(ts).toDateString(),
        timestamp: ts,
        BLOOD_PRESSURE_SYS: row.value,
      };
    }),
    isLoading: false,
  }),
  // v1.4.18 — stubs for the overlay-prefs hook.
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

// The chart pulls in Recharts and the chart kit. Transforming that graph cold
// takes seconds on a loaded machine, so it happens once here, on a hook's
// budget, instead of inside whichever test happens to run first.
beforeAll(async () => {
  await import("../health-chart");
}, 60_000);

describe("<HealthChart compareBaseline=...>", () => {
  it("renders no comparison caption when baseline is 'none' (regression guard)", async () => {
    const { I18nProvider } = await import("@/lib/i18n/context");
    const { HealthChart } = await import("../health-chart");

    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <HealthChart
          types={["BLOOD_PRESSURE_SYS"]}
          title="Blood Pressure"
          unit="mmHg"
          compareBaseline="none"
        />
      </I18nProvider>,
    );
    expect(html).not.toContain('data-slot="chart-compare-caption"');
    expect(html).not.toContain('data-slot="chart-compare-unavailable"');
  });

  it("renders an unavailable caption when comparison is on but no prior-period data exists yet", async () => {
    // Our mock's fixture gives 30 consecutive days starting 2026-05-01.
    // The "lastMonth" shift moves them forward 30d → 2026-05-31..2026-06-29.
    // None of those shifted timestamps line up with the visible 2026-05-01..30
    // window, so hasComparisonData → false → unavailable caption renders.
    const { I18nProvider } = await import("@/lib/i18n/context");
    const { HealthChart } = await import("../health-chart");

    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <HealthChart
          types={["BLOOD_PRESSURE_SYS"]}
          title="Blood Pressure"
          unit="mmHg"
          compareBaseline="lastMonth"
        />
      </I18nProvider>,
    );
    expect(html).toContain('data-slot="chart-compare-unavailable"');
  });
});
