import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import type { CoachReadStripData } from "@/lib/insights/derived/coach-read-shape";

/**
 * A cached strip belongs to ONE language.
 *
 * The read carries prose the server writes in the reader's language (the
 * lagged-association note, which iOS shows). The browser cache used to key it
 * by metric alone, so after a language switch the page re-used the answer
 * written for the previous language. `/api/analytics` carries the same
 * warning in its own cache key. The web strip shows the range, so each entry
 * here carries its own range: which one the strip paints says which entry it
 * read.
 *
 * Both entries are seeded, so a key that has stopped separating them shows up
 * as the WRONG sentence rather than as an empty page — a test that only proved
 * "the other locale misses" would also pass if the key stopped matching
 * anything at all.
 */

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { timezone: "UTC", dateOfBirth: null, gender: null },
    isAuthenticated: true,
  }),
}));

// The strip paints nothing until it is client-mounted (React #418).
vi.mock("@/hooks/use-mounted", () => ({ useMounted: () => true }));

import { CoachReadStrip } from "../coach-read-strip";

// The range each entry carries, as the strip paints it ("6.1–7.4" in
// English, "6,1–7,4" in German): the two languages' entries differ by figure,
// not only by decimal mark, so a key that stopped separating them shows the
// wrong range rather than the same one in another spelling.
const GERMAN_RANGE = "6,1\u20137,4";
const ENGLISH_RANGE = "8.2\u20139.3";

function payload(low: number, high: number): CoachReadStripData {
  return {
    baseline: {
      low,
      high,
      latest: low,
      latestDate: "2026-11-27",
      latestIsToday: true,
      placement: "within",
      sampleDays: 30,
    },
    learning: false,
    driver: {
      note: "a note",
      behaviour: "symptom severity",
      outcome: "sleep duration",
    },
  };
}

const METRIC = "SLEEP_DURATION";

/**
 * One client holding BOTH languages' entries — the state a person is in the
 * instant after switching language on a page they had already loaded.
 */
function seededClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(
    queryKeys.insightsCoachRead(METRIC, "de"),
    payload(6.1, 7.4),
  );
  client.setQueryData(
    queryKeys.insightsCoachRead(METRIC, "en"),
    payload(8.2, 9.3),
  );
  return client;
}

function renderStrip(client: QueryClient, locale: "de" | "en"): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale={locale}>
        <CoachReadStrip metricType={METRIC} unit="h" />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("CoachReadStrip — a cached strip is not served to another language", () => {
  it("reads the German entry for a German reader", () => {
    const markup = renderStrip(seededClient(), "de");
    expect(markup).toContain(GERMAN_RANGE);
    expect(markup).not.toContain("8,2");
  });

  it("reads the English entry for an English reader", () => {
    const markup = renderStrip(seededClient(), "en");
    expect(markup).toContain(ENGLISH_RANGE);
    expect(markup).not.toContain("6.1");
  });

  it("does not carry one language's cached sentence into the other on a switch", () => {
    // One client, both renders — exactly what a language switch does to a page
    // that is already warm.
    const client = seededClient();
    const german = renderStrip(client, "de");
    const english = renderStrip(client, "en");

    expect(german).toContain(GERMAN_RANGE);
    expect(english).toContain(ENGLISH_RANGE);
    expect(english).not.toContain("6.1");
  });
});
