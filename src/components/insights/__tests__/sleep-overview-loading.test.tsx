import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";

/**
 * While the analytics read is in flight the stage chart holds its place with
 * a skeleton. Painting the "no stage data yet" card first said something
 * untrue and pushed the duration chart down when the bar replaced it.
 */

const state = { isLoading: true, data: undefined as unknown };

vi.mock("@/lib/queries/use-analytics-query", () => ({
  useAnalyticsQuery: () => state,
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ isAuthenticated: true, user: { timezone: "UTC" } }),
}));
vi.mock("@/hooks/use-insights-layout-prefs", () => ({
  useInsightsLayoutPrefs: () => ({ compareBaseline: "none" }),
}));
vi.mock("../sleep-duration-chart", () => ({
  SleepDurationChart: () => <div data-slot="duration-chart" />,
}));

import { SleepOverview } from "../sleep-overview";
import en from "../../../../messages/en.json";

describe("SleepOverview — loading", () => {
  it("paints a skeleton, not the 'no stage data' card, while loading", () => {
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <SleepOverview />
      </I18nProvider>,
    );
    expect(html).not.toContain(en.insights.sleep.stages.unavailable);
    expect(html).toContain('data-slot="duration-chart"');
  });
});
