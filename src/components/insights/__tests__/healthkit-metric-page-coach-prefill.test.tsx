import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { primeMessages } from "@/lib/i18n/load-locale";
import deMessages from "../../../../messages/de.json";

primeMessages("de", deMessages);

/**
 * A metric page with no data offers the Coach a question in the reader's
 * language. The pages used to pass their own English sentence, and most of
 * them were one sentence with the metric's name swapped in; the page now asks
 * that one, translated, with its own title, and a metric with a question of
 * its own reads it from the catalog too.
 */

const prefills: Array<string | null | undefined> = [];
vi.mock("@/components/insights/metric-empty-state", () => ({
  MetricEmptyState: ({ coachPrefill }: { coachPrefill?: string | null }) => {
    prefills.push(coachPrefill);
    return null;
  },
}));
vi.mock("@/hooks/use-ai-capability", () => ({
  useAiCapability: () => ({ available: true, reason: null }),
}));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/insights/visceral-fat",
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { timezone: "UTC", dateOfBirth: null, gender: null },
    isAuthenticated: true,
  }),
}));
vi.mock("@/hooks/use-insights-layout-prefs", () => ({
  useInsightsLayoutPrefs: () => ({ layout: null, compareBaseline: false }),
}));
vi.mock("@/hooks/use-insights-analytics", () => ({
  useInsightsAnalytics: () => ({ data: { summaries: {} }, isEmpty: true }),
}));

import InsightsViszeralfettPage from "@/app/insights/visceral-fat/page";
import InsightsStepsPage from "@/app/insights/steps/page";

function emptyStatePrefill(node: React.ReactNode, locale: "en" | "de") {
  prefills.length = 0;
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider initialLocale={locale}>{node}</I18nProvider>
    </QueryClientProvider>,
  );
  return prefills.at(-1);
}

describe("the empty metric page's Coach question", () => {
  it("is the shared sentence with the page's title, in the reader's language", () => {
    expect(emptyStatePrefill(<InsightsViszeralfettPage />, "de")).toBe(
      "Viszeralfett: Ich habe hier noch nichts erfasst. Was sagt dieser Wert über meine Gesundheit aus, und wie verbessere ich ihn?",
    );
    expect(emptyStatePrefill(<InsightsViszeralfettPage />, "en")).toBe(
      "Visceral Fat: I haven't logged anything here yet. What does this metric tell me about my health, and how do I improve it?",
    );
  });

  it("keeps a metric's own question, translated", () => {
    expect(emptyStatePrefill(<InsightsStepsPage />, "de")).toBe(
      "Ich habe noch keine Schritte erfasst. Was ist ein sinnvolles tägliches Schrittziel, und wie hilft mehr Gehen meiner Gesundheit?",
    );
  });
});
