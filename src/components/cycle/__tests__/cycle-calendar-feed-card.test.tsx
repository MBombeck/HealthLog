import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

import { CycleCalendarFeedCard } from "../cycle-calendar-feed-card";
import type { CycleFeedStatus } from "../use-cycle-feed";

function render(status: CycleFeedStatus) {
  const client = new QueryClient();
  client.setQueryData(queryKeys.cycleFeedSubscription(), status);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en">
        <CycleCalendarFeedCard />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

const FEED = {
  tokenPrefix: "hlf_ab12",
  createdAt: "2026-11-01T10:00:00.000Z",
  lastFetchedAt: null,
  fetchCount: 0,
  lastFetcher: null,
  horizonCycles: 3,
  historyCycles: 0,
  includeFertile: false,
  titleMode: "DISCREET" as const,
  forecastStyle: "MARGIN" as const,
};

describe("<CycleCalendarFeedCard>", () => {
  it("says what a provider keeps before it offers the button", () => {
    const html = render({
      feed: null,
      projectionState: null,
      fertileAvailable: false,
    });
    const disclosure = html.indexOf("stores these dates on its servers");
    const button = html.indexOf("Turn on subscription");
    expect(disclosure).toBeGreaterThan(-1);
    expect(button).toBeGreaterThan(disclosure);
  });

  it("shows only the prefix of a live link, and no URL", () => {
    const html = render({
      feed: FEED,
      projectionState: "OK",
      fertileAvailable: false,
    });
    expect(html).toContain("hlf_ab12");
    expect(html).not.toContain("/api/cycle/feed/");
    expect(html).toContain("Not fetched yet.");
    // The fertile option exists only for a conception goal.
    expect(html).not.toContain("Fertile window");
  });

  it("offers the three forecast styles and explains the chosen one", () => {
    const html = render({
      feed: FEED,
      projectionState: "OK",
      fertileAvailable: false,
    });
    expect(html).toContain("How forecasts look");
    for (const value of ["EXACT", "MARGIN", "BAND"]) {
      expect(html).toContain(`value="${value}"`);
    }
    expect(html).toContain('aria-describedby="cycle-feed-forecast-hint"');
    expect(html).toMatch(
      /data-slot="cycle-feed-forecast-hint"[^>]*>Expected days, with the days the period may start earlier or later as separate entries\.</,
    );

    const band = render({
      feed: { ...FEED, forecastStyle: "BAND" },
      projectionState: "OK",
      fertileAvailable: false,
    });
    expect(band).toContain(
      "One entry covering every day the period may fall on.",
    );
    expect(band).not.toContain("as separate entries");
  });

  it("explains a shorter feed in the muted tone", () => {
    const html = render({
      feed: FEED,
      projectionState: "LATE",
      fertileAvailable: true,
    });
    expect(html).toContain('data-slot="cycle-feed-state"');
    expect(html).toContain("later than expected");
    expect(html).toContain("Fertile window");
  });
});
