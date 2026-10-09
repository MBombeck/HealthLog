import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

/**
 * v1.42 — the score history chart: the shared range tabs on the remembered
 * range, the day table as the keyboard way to every point's day, the usual
 * range and the seam named under the chart, and the honest empty state.
 * The query is seeded; the plot itself does not draw under SSR.
 */

vi.mock("@/lib/api/api-fetch", () => ({
  apiGet: () => new Promise(() => {}),
  apiPut: vi.fn(),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ isAuthenticated: true, user: { id: "u1" } }),
}));

const prefs: {
  rangePoints: number | undefined;
  lastKey: string | undefined;
  setPrefs: ReturnType<typeof vi.fn>;
} = { rangePoints: undefined, lastKey: undefined, setPrefs: vi.fn() };
vi.mock("@/hooks/use-chart-overlay-prefs", () => ({
  useChartOverlayPrefs: (key: string) => {
    prefs.lastKey = key;
    return {
      prefs: {
        showTrendIndicator: false,
        showTrendArrow: false,
        showTargetRange: false,
        comparisonBaseline: "none",
        rangePoints: prefs.rangePoints,
      },
      setPrefs: prefs.setPrefs,
      isSaving: false,
    };
  },
}));

import { ScoreTrendChart, toChartRows } from "../score-trend-chart";

type Point = { day: string; value: number; seamBreak: boolean };

function render(
  days: number,
  data: {
    points: Point[];
    band: { lo: number; hi: number; n: number } | null;
  } | null,
): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (data) {
    client.setQueryData(queryKeys.insightsScoreHistory("HEALTH_SCORE", days), {
      score: "HEALTH_SCORE",
      days,
      ...data,
    });
  }
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en">
        <ScoreTrendChart
          score="HEALTH_SCORE"
          chartKey="scoreHealth"
          color="var(--chart-1)"
          label="Health Score"
        />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

const POINTS: Point[] = [
  { day: "2026-06-01", value: 61, seamBreak: false },
  { day: "2026-06-02", value: 64, seamBreak: false },
  { day: "2026-06-03", value: 70, seamBreak: true },
];

beforeEach(() => {
  prefs.rangePoints = undefined;
  prefs.setPrefs.mockReset();
});

describe("<ScoreTrendChart>", () => {
  it("offers the four range tabs every chart offers, on 30 days by default", () => {
    const html = render(30, { points: POINTS, band: null });
    const tabs = html.match(/<button[^>]*data-slot="chart-range-tab"[^>]*>/g);
    expect(tabs).toHaveLength(4);
    expect(tabs!.map((tab) => tab.match(/data-range="(\d+)"/)![1])).toEqual([
      "7",
      "30",
      "90",
      "0",
    ]);
    const pressed = tabs!.filter((tab) => tab.includes('aria-pressed="true"'));
    expect(pressed).toHaveLength(1);
    expect(pressed[0]).toContain('data-range="30"');
    expect(html).toContain('data-slot="score-trend-chart"');
    // The range is remembered under the page's own slot.
    expect(prefs.lastKey).toBe("scoreHealth");
  });

  it("opens on the remembered range and asks for its window", () => {
    prefs.rangePoints = 90;
    const html = render(90, { points: POINTS, band: null });
    const pressed = (
      html.match(/<button[^>]*data-slot="chart-range-tab"[^>]*>/g) ?? []
    ).filter((tab) => tab.includes('aria-pressed="true"'));
    expect(pressed).toHaveLength(1);
    expect(pressed[0]).toContain('data-range="90"');
    // The seeded 90-day read is the one the chart drew from.
    expect(html.match(/data-slot="chart-data-table-row"/g)).toHaveLength(3);
  });

  it("asks for ten years on the All tab", () => {
    prefs.rangePoints = 0;
    const html = render(3650, { points: POINTS, band: null });
    expect(html).toContain('data-slot="chart-data-table"');
  });

  it("lists every point with a link to its day", () => {
    const html = render(30, { points: POINTS, band: null });
    expect(html.match(/data-slot="chart-data-table-row"/g)).toHaveLength(3);
    for (const point of POINTS) {
      expect(html).toContain(point.day);
    }
    expect(html).toContain('data-slot="chart-plot"');
  });

  it("names the usual range and the seam under the chart", () => {
    const html = render(30, {
      points: POINTS,
      band: { lo: 60, hi: 68, n: 12 },
    });
    expect(html).toContain('data-slot="score-trend-band"');
    expect(html).toContain("your usual range, 60 to 68");
    expect(html).toContain('data-slot="score-trend-seam"');
  });

  it("says nothing about a range or a seam it does not have", () => {
    const html = render(30, {
      points: POINTS.map((p) => ({ ...p, seamBreak: false })),
      band: null,
    });
    expect(html).not.toContain("score-trend-band");
    expect(html).not.toContain("score-trend-seam");
  });

  it("paints the empty state, not an empty plot, for a window without points", () => {
    const html = render(30, { points: [], band: null });
    expect(html).toContain('data-slot="chart-empty-state"');
    expect(html).not.toContain('data-slot="chart-plot"');
    expect(html).not.toContain('data-slot="chart-data-table"');
  });

  it("holds the plot's height while the first read is in flight", () => {
    const html = render(30, null);
    expect(html).toContain('data-slot="skeleton"');
  });
});

describe("toChartRows", () => {
  it("alternates the series key at every seam, so no line crosses one", () => {
    const rows = toChartRows([
      { day: "2026-06-01", value: 50, seamBreak: false },
      { day: "2026-06-02", value: 52, seamBreak: false },
      { day: "2026-06-03", value: 80, seamBreak: true },
      { day: "2026-06-05", value: 81, seamBreak: false },
      { day: "2026-06-06", value: 60, seamBreak: true },
    ]);
    expect(rows.map((r) => [r.even ?? null, r.odd ?? null])).toEqual([
      [50, null],
      [52, null],
      [null, 80],
      [null, 81],
      [60, null],
    ]);
    expect(rows[0]!.timestamp).toBe(Date.parse("2026-06-01T12:00:00.000Z"));
  });

  it("does not treat a seam flag on the first point as a break", () => {
    const [first] = toChartRows([
      { day: "2026-06-01", value: 50, seamBreak: true },
    ]);
    expect(first).toMatchObject({ even: 50 });
  });
});
