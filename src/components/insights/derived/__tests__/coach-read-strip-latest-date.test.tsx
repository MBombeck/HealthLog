import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import type { Locale } from "@/lib/i18n/config";
import { queryKeys } from "@/lib/query-keys";
import type { CoachReadStripData } from "@/lib/insights/derived/coach-read-shape";

/**
 * The strip used to call the newest reading "today's" on every metric page,
 * even when it was days old. The server now says which day the reading is
 * from and whether that is today; the sentence names the date otherwise.
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

function render(data: CoachReadStripData, locale: Locale = "en"): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(queryKeys.insightsCoachRead(METRIC, locale), data);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale={locale}>
        <CoachReadStrip metricType={METRIC} unit="bpm" />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

function strip(
  latestIsToday: boolean,
  placement: "within" | "above" | "below" = "within",
  band: { low: number; high: number } = { low: 55, high: 62 },
): CoachReadStripData {
  return {
    baseline: {
      ...band,
      latest: 58,
      latestDate: latestIsToday ? "2026-10-06" : "2026-10-01",
      latestIsToday,
      placement,
      sampleDays: 20,
    },
    learning: false,
    driver: null,
  };
}

describe("CoachReadStrip — the latest reading's day", () => {
  it("calls a reading from today today's", () => {
    const markup = render(strip(true));
    expect(markup).toContain("today&#x27;s 58 sits within it");
    expect(markup).not.toContain("latest reading");
  });

  it("names the date of an older reading instead of calling it today's", () => {
    const markup = render(strip(false));
    expect(markup).not.toContain("today");
    expect(markup).toContain(
      "your latest reading, October 1, was 58, within it",
    );
    expect(render(strip(false, "above"))).toContain("was 58, above it");
    expect(render(strip(false, "below"))).toContain("was 58, below it");
  });

  it("names the date on a steady band too", () => {
    const markup = render(strip(false, "within", { low: 58, high: 58 }));
    expect(markup).not.toContain("today");
    expect(markup).toContain("your latest reading, October 1, was 58");
  });

  it("says it in every shipped language", () => {
    const expected: Record<Locale, string> = {
      de: "1. Oktober",
      en: "October 1",
      es: "1 de octubre",
      fr: "1 octobre",
      it: "1 ottobre",
      ko: "10월 1일",
      pl: "1 października",
    };
    for (const [locale, date] of Object.entries(expected) as Array<
      [Locale, string]
    >) {
      const markup = render(strip(false), locale);
      expect(markup, locale).toContain(date);
      expect(markup, locale).toContain("58");
    }
  });
});
