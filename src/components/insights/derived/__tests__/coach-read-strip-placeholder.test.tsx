import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";

/**
 * The strip sits above the chart on every metric sub-page. While its read is
 * on the way it holds its place with a card of the same anatomy, so the chart
 * and everything below it do not jump down when the read lands.
 */

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { timezone: "UTC", dateOfBirth: null, gender: null },
    isAuthenticated: true,
  }),
}));

vi.mock("@/hooks/use-mounted", () => ({ useMounted: () => true }));

import { CoachReadStrip } from "../coach-read-strip";

describe("CoachReadStrip — placeholder while the read loads", () => {
  it("paints the card frame and title before the read lands", () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, enabled: false } },
    });
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <I18nProvider initialLocale="en">
          <CoachReadStrip metricType="WEIGHT" unit="kg" />
        </I18nProvider>
      </QueryClientProvider>,
    );
    expect(markup).toContain('data-slot="coach-read-strip"');
    expect(markup).toContain('data-state="loading"');
    expect(markup).toContain('aria-busy="true"');
  });
});
