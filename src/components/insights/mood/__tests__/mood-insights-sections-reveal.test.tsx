/**
 * v1.42 — the mood calendar no longer pops in after the line chart.
 *
 * While the shared read is pending, and while the page holds the reveal until
 * the chart is ready too, the heatmap region paints the calendar's card with
 * a skeleton at the calendar's final height — the same reserved box the
 * painted grid uses — instead of nothing. Before this release the region
 * rendered nothing while loading, so the calendar arrived later and pushed
 * the chart down.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { id: "u1" },
    isLoading: false,
    isAuthenticated: true,
  }),
}));

const state = { current: {} as Record<string, unknown> };
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => state.current,
}));

import { I18nProvider } from "@/lib/i18n/context";
import { MoodInsightsSections } from "../mood-insights-sections";

const LOADED = {
  data: {
    summary: { totalEntries: 12, inTargetPct: null },
    heatmap: { windowDays: 40, cells: [] },
    betterDays: [],
  },
  isLoading: false,
  isPending: false,
  isError: false,
  refetch: vi.fn(),
};

function render(reveal?: boolean) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <MoodInsightsSections region="heatmap" reveal={reveal} />
    </I18nProvider>,
  );
}

describe("<MoodInsightsSections region=heatmap> reveal", () => {
  it("paints the calendar card with a reserved-height skeleton while the read is pending", () => {
    state.current = {
      data: undefined,
      isLoading: true,
      isPending: true,
      isError: false,
      refetch: vi.fn(),
    };
    const html = render();
    expect(html).toContain("Mood calendar");
    expect(html).toContain('data-slot="mood-heatmap-skeleton"');
    expect(html).toMatch(/data-slot="mood-heatmap-body" style="height:calc\(/);
  });

  it("holds the skeleton while the page has not revealed, then paints the grid", () => {
    state.current = LOADED;
    const held = render(false);
    expect(held).toContain('data-slot="mood-heatmap-skeleton"');
    const shown = render(true);
    expect(shown).not.toContain('data-slot="mood-heatmap-skeleton"');
    expect(shown).toContain('role="img"');
  });

  it("the skeleton and the grid reserve the same box for the same window", () => {
    state.current = LOADED;
    const box = (html: string) =>
      /data-slot="mood-heatmap-body" style="(height:[^"]+)"/.exec(html)?.[1];
    expect(box(render(false))).toBeDefined();
    expect(box(render(false))).toBe(box(render(true)));
  });
});
