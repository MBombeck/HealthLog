import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import type { CoachReadStripData } from "@/lib/insights/derived/coach-read-shape";

/**
 * A glucose day still in progress is placed against the same hours of the
 * earlier days. The range is then the usual one for this time of day and the
 * figure is today's mean so far, and the sentence has to say so: printed as
 * "your usual range", a morning range would read as the whole-day one.
 */

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { timezone: "UTC", dateOfBirth: null, gender: null },
    isAuthenticated: true,
  }),
}));

vi.mock("@/hooks/use-mounted", () => ({ useMounted: () => true }));

import { CoachReadStrip } from "../coach-read-strip";

const METRIC = "BLOOD_GLUCOSE";

function render(data: CoachReadStripData, locale: "en" | "de" = "en"): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(queryKeys.insightsCoachRead(METRIC, locale), data);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale={locale}>
        <CoachReadStrip metricType={METRIC} unit="mg/dL" />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

function sameHours(
  latest: number,
  placement: "within" | "above" | "below",
): CoachReadStripData {
  return {
    baseline: {
      low: 80,
      high: 90,
      latest,
      placement,
      sampleDays: 14,
      latestDate: "2026-10-06",
      latestIsToday: true,
      basis: "sameHours",
    },
    learning: false,
    driver: null,
  };
}

describe("CoachReadStrip — a glucose day in progress", () => {
  it("names the range as the one for this time of day", () => {
    const markup = render(sameHours(86, "within"));
    expect(markup).toContain("By this time of day");
    expect(markup).toContain("today so far, 86 is within that");
    expect(markup).not.toContain("Your usual range");
  });

  it("keeps the placement", () => {
    expect(render(sameHours(95, "above"))).toContain("is above that");
    expect(render(sameHours(70, "below"))).toContain("is below that");
  });

  it("says it in the reader's language", () => {
    expect(render(sameHours(86, "within"), "de")).toContain(
      "Bis zu dieser Tageszeit",
    );
  });

  it("keeps the whole-day sentence without the basis", () => {
    const markup = render({
      baseline: {
        low: 110,
        high: 150,
        latest: 132,
        placement: "within",
        sampleDays: 30,
        latestDate: "2026-10-06",
        latestIsToday: true,
      },
      learning: false,
      driver: null,
    });
    expect(markup).toContain("Your usual range is 110–150");
  });
});
