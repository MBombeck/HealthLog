import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import type { DataSummary } from "@/lib/analytics/trends";

/**
 * v1.17.1 — the WHOOP / Oura / Polar device-native score surfaces.
 *
 * `<SleepQualitySection>` (sleep page) and `<RecoverySection>`
 * (`/insights/recovery`) surface metrics that were ingested end-to-end but
 * never rendered. The contract under test is the DATA-GATING: a tile / section
 * appears ONLY when its metric has stored readings, so a non-wearable account
 * never sees an empty card. `<DeviceScoreTile>` carries the same gate plus a
 * sparse-data `<LearningGate>` swap.
 */

// The mini chart is `next/dynamic`-imported; SSR renders the stub.
vi.mock("next/dynamic", () => ({
  default: () => {
    const Stub = () => <div data-slot="mini-chart-stub" />;
    Stub.displayName = "MiniChartStub";
    return Stub;
  },
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { timezone: "UTC" },
    isAuthenticated: true,
  }),
}));

const analyticsMock = vi.fn();
vi.mock("@/hooks/use-insights-analytics", () => ({
  useInsightsAnalytics: () => analyticsMock(),
}));

import { DeviceScoreTile } from "../device-score-tile";
import { SleepQualitySection } from "../sleep/sleep-quality-section";
import { RecoverySection } from "../recovery/recovery-section";

function render(node: React.ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLocale="en">{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

function summary(over: Partial<DataSummary>): DataSummary {
  return {
    count: 0,
    latest: null,
    min: null,
    max: null,
    mean: null,
    median: null,
    avg7: null,
    avg30: null,
    slope7: null,
    slope30: null,
    anomalyCount: 0,
    ...over,
  };
}

function analyticsWith(summaries: Record<string, DataSummary>) {
  return {
    data: { summaries },
    isLoading: false,
    isEmpty: false,
    error: null,
    refetch: () => {},
  };
}

function analyticsLoading() {
  return {
    data: undefined,
    isLoading: true,
    isEmpty: false,
    error: null,
    refetch: () => {},
  };
}

beforeEach(() => {
  analyticsMock.mockReset();
});

describe("<DeviceScoreTile> gating", () => {
  it("renders nothing when the metric has no readings", () => {
    const html = render(
      <DeviceScoreTile
        type="SLEEP_EFFICIENCY"
        summary={summary({ count: 0 })}
        title="Sleep efficiency"
        icon={() => null}
        color="#50fa7b"
        unit="%"
      />,
    );
    expect(html).toBe("");
  });

  it("shows the latest reading + sparkline once it has enough data", () => {
    const html = render(
      <DeviceScoreTile
        type="SLEEP_EFFICIENCY"
        summary={summary({ count: 12, latest: 91, mean: 88 })}
        title="Sleep efficiency"
        icon={() => null}
        color="#50fa7b"
        unit="%"
      />,
    );
    expect(html).toContain('data-slot="device-score-tile"');
    expect(html).toContain('data-slot="device-score-latest"');
    expect(html).toContain("91");
    expect(html).toContain('data-slot="mini-chart-stub"');
    // No learning gate once past the threshold.
    expect(html).not.toContain('data-slot="device-score-learning"');
  });

  it("swaps the sparkline for the LearningGate while the series is sparse", () => {
    const html = render(
      <DeviceScoreTile
        type="DAY_STRAIN"
        summary={summary({ count: 2, latest: 9, mean: 8 })}
        title="Day strain"
        icon={() => null}
        color="#ffb86c"
      />,
    );
    expect(html).toContain('data-slot="device-score-learning"');
    expect(html).not.toContain('data-slot="mini-chart-stub"');
  });
});

describe("device-score loading skeletons", () => {
  it("paints the shared Skeleton grid for sleep-quality while loading", () => {
    analyticsMock.mockReturnValue(analyticsLoading());
    const html = render(<SleepQualitySection enabled />);
    expect(html).toContain('data-slot="sleep-quality-loading"');
    expect(html).toContain('data-slot="device-score-grid-skeleton"');
    expect(html).toContain('data-slot="skeleton"');
    // No real tiles while the slice is still loading.
    expect(html).not.toContain('data-slot="device-score-tile"');
  });

  it("paints a chart skeleton for recovery while loading", () => {
    analyticsMock.mockReturnValue(analyticsLoading());
    const html = render(<RecoverySection />);
    expect(html).toContain('data-slot="recovery-loading"');
    // v1.18.1 — the rebuilt page leads with canonical chart blocks, so the
    // loading shell reserves a chart skeleton (not the old tile grid).
    expect(html).toContain('data-slot="chart-skeleton"');
    expect(html).not.toContain('data-slot="recovery-empty"');
  });
});

describe("<SleepQualitySection> data-gating", () => {
  it("collapses to nothing when no sleep-quality metric has data", () => {
    analyticsMock.mockReturnValue(
      analyticsWith({ SLEEP_DURATION: summary({ count: 30 }) }),
    );
    const html = render(<SleepQualitySection enabled />);
    expect(html).not.toContain('data-slot="sleep-quality-section"');
  });

  it("renders only the metrics that have readings", () => {
    analyticsMock.mockReturnValue(
      analyticsWith({
        SLEEP_EFFICIENCY: summary({ count: 20, latest: 92, mean: 90 }),
        SLEEP_SCORE: summary({ count: 0 }),
      }),
    );
    const html = render(<SleepQualitySection enabled />);
    expect(html).toContain('data-slot="sleep-quality-section"');
    expect(html).toContain('data-metric="SLEEP_EFFICIENCY"');
    expect(html).not.toContain('data-metric="SLEEP_SCORE"');
  });

  it("renders nothing when disabled", () => {
    analyticsMock.mockReturnValue(
      analyticsWith({ SLEEP_EFFICIENCY: summary({ count: 20 }) }),
    );
    const html = render(<SleepQualitySection enabled={false} />);
    expect(html).toBe("");
  });
});

describe("<RecoverySection> data-gating", () => {
  it("shows the calm empty note when there is no recovery data at all", () => {
    // The server resolves the empty reason beside the summaries.
    const empty = analyticsWith({ SLEEP_DURATION: summary({ count: 10 }) });
    analyticsMock.mockReturnValue({
      ...empty,
      data: { ...empty.data, recoveryEmpty: "general" },
    });
    const html = render(<RecoverySection />);
    expect(html).toContain('data-slot="recovery-empty"');
    // Routed through the shared <EmptyState> (dashed bordered card), not the
    // old hand-rolled div — the empty title comes from the unified primitive.
    expect(html).toContain('data-slot="empty-state-title"');
    expect(html).not.toContain('data-slot="recovery-block-DAY_STRAIN"');
    expect(html).not.toContain("Connect a WHOOP, Polar or Oura account");
    expect(html).toContain("WHOOP or Polar");
  });

  it("renders a canonical chart block for the present signal", () => {
    analyticsMock.mockReturnValue(
      analyticsWith({
        DAY_STRAIN: summary({ count: 14, latest: 12, mean: 11 }),
        RECOVERY_SCORE: summary({ count: 14, latest: 66, mean: 60 }),
        ANS_CHARGE: summary({ count: 0 }),
      }),
    );
    const html = render(<RecoverySection />);
    // v1.18.6 — the per-group sub-headings are gone; present blocks render as
    // one flat stack. The data gate now reads at the block level.
    expect(html).toContain('data-slot="recovery-block-DAY_STRAIN"');
    // B3 — the redundant "Recovery score" cross-link block is gone; this
    // surface is reached from the overview already.
    expect(html).not.toContain('data-slot="recovery-score-link"');
    // The recharge group's only signal (ANS charge) has no data → its block
    // is dropped.
    expect(html).not.toContain('data-slot="recovery-block-ANS_CHARGE"');
    // The removed sub-headings must not reappear.
    expect(html).not.toContain('data-slot="recovery-group-strain"');
    expect(html).not.toContain("Strain &amp; load");
    // Empty note must not show when at least one signal is present.
    expect(html).not.toContain('data-slot="recovery-empty"');
  });
});

describe("<ResilienceTile> on the recovery surface", () => {
  it("stays hidden when there is no resilience reading", () => {
    analyticsMock.mockReturnValue(
      analyticsWith({
        DAY_STRAIN: summary({ count: 14, latest: 12, mean: 11 }),
        RESILIENCE: summary({ count: 0 }),
      }),
    );
    const html = render(<RecoverySection />);
    expect(html).not.toContain('data-slot="resilience-tile"');
  });

  it("names the latest band and explains it once enough days exist", () => {
    analyticsMock.mockReturnValue(
      analyticsWith({
        // latest ordinal 4 → "strong"; mean 3 → above the recent average.
        RESILIENCE: summary({ count: 9, latest: 4, mean: 3 }),
      }),
    );
    const html = render(<RecoverySection />);
    expect(html).toContain('data-slot="resilience-tile"');
    expect(html).toContain('data-slot="resilience-band"');
    expect(html).toContain("Strong");
    expect(html).toContain('data-slot="resilience-trend"');
    expect(html).toContain("Above your recent average.");
    // Calm by construction — no learning gate once past the threshold.
    expect(html).not.toContain('data-slot="resilience-learning"');
  });

  it("shows the calm learning note while the series is still sparse", () => {
    analyticsMock.mockReturnValue(
      analyticsWith({
        RESILIENCE: summary({ count: 2, latest: 3, mean: 3 }),
      }),
    );
    const html = render(<RecoverySection />);
    expect(html).toContain('data-slot="resilience-tile"');
    expect(html).toContain('data-slot="resilience-learning"');
    // No trend cue until the band has settled.
    expect(html).not.toContain('data-slot="resilience-trend"');
  });

  it("keeps the recovery surface non-empty when resilience is the only signal", () => {
    analyticsMock.mockReturnValue(
      analyticsWith({
        SLEEP_DURATION: summary({ count: 10 }),
        RESILIENCE: summary({ count: 9, latest: 2, mean: 2 }),
      }),
    );
    const html = render(<RecoverySection />);
    expect(html).not.toContain('data-slot="recovery-empty"');
    expect(html).toContain('data-slot="resilience-tile"');
    // "adequate" band label is surfaced.
    expect(html).toContain("Adequate");
  });
});
