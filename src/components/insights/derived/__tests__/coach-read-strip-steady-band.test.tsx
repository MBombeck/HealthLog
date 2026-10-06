import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import type { CoachReadStripData } from "@/lib/insights/derived/coach-read-shape";

/**
 * A band whose two ends format to the same figure is a steady value.
 *
 * With many identical daily readings the robust band collapses, and the strip
 * read "Your usual range is 61–61 bpm". It now names the one value instead,
 * and keeps the placement of today's reading.
 */

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { timezone: "UTC", dateOfBirth: null, gender: null },
    isAuthenticated: true,
  }),
}));

vi.mock("@/hooks/use-mounted", () => ({ useMounted: () => true }));

import { CoachReadStrip } from "../coach-read-strip";

const METRIC = "RESTING_HEART_RATE";

function render(data: CoachReadStripData): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(queryKeys.insightsCoachRead(METRIC, "en"), data);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en">
        <CoachReadStrip metricType={METRIC} unit="bpm" />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

function band(
  low: number,
  high: number,
  latest: number,
  placement: "within" | "above" | "below",
): CoachReadStripData {
  return {
    baseline: {
      low,
      high,
      latest,
      placement,
      sampleDays: 30,
      latestDate: "2026-10-06",
      latestIsToday: true,
    },
    learning: false,
    driver: null,
  };
}

describe("CoachReadStrip — steady band", () => {
  it("names one value when both ends format alike", () => {
    const markup = render(band(61, 61.04, 61, "within"));
    expect(markup).not.toContain("61–61");
    expect(markup).toContain("usually sit at 61");
  });

  it("keeps the placement for a steady value", () => {
    expect(render(band(61, 61, 66, "above"))).toContain("is above that");
    expect(render(band(61, 61, 57, "below"))).toContain("is below that");
  });

  it("still shows a real range as a range", () => {
    expect(render(band(58, 64, 61, "within"))).toContain("58–64");
  });
});
