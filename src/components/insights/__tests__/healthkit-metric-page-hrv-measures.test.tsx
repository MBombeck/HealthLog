import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";

/**
 * #1110 — since iOS 27 one Apple Watch writes both HRV measures, SDNN
 * (`HEART_RATE_VARIABILITY`) and RMSSD (`HRV_RMSSD`). The page used to chart
 * RMSSD only when there was no SDNN at all, so a watch writing both showed
 * SDNN and hid RMSSD. With both present each now gets its own chart, titled
 * with its measure; they are never drawn as one line.
 *
 * The chart is `next/dynamic`; the stub echoes the props that matter.
 */
vi.mock("@/hooks/use-ai-capability", () => ({
  useAiCapability: () => ({
    available: true,
    reason: null,
    onDeviceAllowed: true,
  }),
}));
vi.mock("next/dynamic", () => ({
  default: () => {
    const Stub = (props: { types?: string[]; title?: string }) => (
      <div
        data-slot="chart-stub"
        data-types={(props.types ?? []).join(",")}
        data-title={props.title ?? ""}
      />
    );
    Stub.displayName = "HealthChartStub";
    return Stub;
  },
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/insights/hrv" }));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { timezone: "UTC", dateOfBirth: null, gender: null },
    isAuthenticated: true,
  }),
}));
vi.mock("@/hooks/use-insights-layout-prefs", () => ({
  useInsightsLayoutPrefs: () => ({ layout: null, compareBaseline: false }),
}));
const analyticsMock = vi.fn();
vi.mock("@/hooks/use-insights-analytics", () => ({
  useInsightsAnalytics: () => analyticsMock(),
}));

import InsightsHrvPage from "@/app/insights/hrv/page";

function render() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLocale="en">
        <InsightsHrvPage />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

function charts(html: string): Array<{ types: string; title: string }> {
  return [...html.matchAll(/data-types="([^"]*)" data-title="([^"]*)"/g)].map(
    (m) => ({ types: m[1]!, title: m[2]! }),
  );
}

beforeEach(() => analyticsMock.mockReset());

describe("/insights/hrv — SDNN and RMSSD kept apart (#1110)", () => {
  it("charts each measure on its own when both have readings", () => {
    analyticsMock.mockReturnValue({
      data: {
        summaries: {
          HEART_RATE_VARIABILITY: { count: 30 },
          HRV_RMSSD: { count: 28 },
        },
      },
      isEmpty: false,
    });
    const found = charts(render());
    expect(found).toHaveLength(2);
    expect(found[0]).toMatchObject({ types: "HEART_RATE_VARIABILITY" });
    expect(found[0]!.title).toMatch(/SDNN$/);
    expect(found[1]).toMatchObject({ types: "HRV_RMSSD" });
    expect(found[1]!.title).toMatch(/RMSSD$/);
  });

  it("keeps one unlabelled SDNN chart when there is no RMSSD", () => {
    analyticsMock.mockReturnValue({
      data: { summaries: { HEART_RATE_VARIABILITY: { count: 30 } } },
      isEmpty: false,
    });
    const found = charts(render());
    expect(found).toHaveLength(1);
    expect(found[0]!.types).toBe("HEART_RATE_VARIABILITY");
    expect(found[0]!.title).not.toMatch(/SDNN|RMSSD/);
  });

  it("charts RMSSD alone, labelled, for a ring or strap user", () => {
    analyticsMock.mockReturnValue({
      data: { summaries: { HRV_RMSSD: { count: 28 } } },
      isEmpty: false,
    });
    const found = charts(render());
    expect(found).toHaveLength(1);
    expect(found[0]!.types).toBe("HRV_RMSSD");
    expect(found[0]!.title).toMatch(/RMSSD$/);
  });
});
