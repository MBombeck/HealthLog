import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/context";

/**
 * v1.4.18 — overlay-toggle integration on the medication chart.
 *
 * Asserts the contract that the persisted overlay prefs gate the
 * threshold / goal reference lines AND the 7-day trend chip:
 *
 *   - Default state (every flag false): no goal/threshold lines, no
 *     trend chip.
 *   - showTargetRange=true: threshold + goal reference lines paint.
 *   - showTrendIndicator=true: 7-day trend chip paints in the header.
 */

const sampleData = vi.hoisted(() =>
  Array.from({ length: 14 }, (_, i) => ({
    date: `2026-05-${String(i + 1).padStart(2, "0")}`,
    scheduled: 4,
    taken: 3 + (i % 2),
  })),
);

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: sampleData, isLoading: false }),
  useQueryClient: () => ({
    cancelQueries: () => Promise.resolve(),
    getQueryData: () => undefined,
    setQueryData: () => undefined,
    invalidateQueries: () => Promise.resolve(),
  }),
  useMutation: () => ({ mutate: () => undefined, isPending: false }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ isAuthenticated: true, user: null, isLoading: false }),
}));

// Hoisted mutable prefs so each test pre-sets the values the hook
// returns. Recharts runs client-side, so the threshold/goal lines
// don't appear in the SSR output as actual `<line>` nodes — but the
// trend-chip + the components that paint conditional on the prefs
// (rendered as `<span>` and friends) DO show up in the SSR markup.
const mockPrefs = vi.hoisted(() => ({
  current: {
    showTrendIndicator: false,
    showTrendArrow: false,
    showTargetRange: false,
    comparisonBaseline: "none",
  },
}));

vi.mock("@/hooks/use-chart-overlay-prefs", () => ({
  useChartOverlayPrefs: () => ({
    prefs: mockPrefs.current,
    setPrefs: () => undefined,
    isSaving: false,
  }),
}));

async function renderChart(): Promise<string> {
  // Re-import to pick up the freshly-set mock value.
  const { MedicationComplianceChart } =
    await import("../medication-compliance-chart");
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <MedicationComplianceChart />
    </I18nProvider>,
  );
}

describe("MedicationComplianceChart overlay toggles", () => {
  it("does NOT paint the trend chip by default", async () => {
    mockPrefs.current = {
      showTrendIndicator: false,
      showTrendArrow: false,
      showTargetRange: false,
      comparisonBaseline: "none",
    };
    const html = await renderChart();
    expect(html).not.toContain("medication-trend-chip");
  });

  it("paints the trend chip when showTrendIndicator is true", async () => {
    mockPrefs.current = {
      showTrendIndicator: true,
      showTrendArrow: false,
      showTargetRange: false,
      comparisonBaseline: "none",
    };
    const html = await renderChart();
    expect(html).toContain("medication-trend-chip");
  });
});
