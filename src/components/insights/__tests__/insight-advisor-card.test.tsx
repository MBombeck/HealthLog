import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// HealthChart pulls in TanStack Query + recharts. We don't care about its
// internal rendering — we only need to know *that it was rendered* and
// with which `types[]` (which is the chart's metric handle, since the
// real component takes `types: string[]` not `metric: string`).
vi.mock("@/components/charts/health-chart", () => ({
  HealthChart: ({ types, title }: { types: string[]; title: string }) => (
    <div data-testid="health-chart" data-types={types.join(",")}>
      chart:{title}
    </div>
  ),
}));

// Stub TanStack Query — InsightAdvisorCard itself doesn't query, but
// nested clients (and the HealthChart mock above replaces the real one)
// pull from this. Safe no-op.
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: null, isLoading: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { InsightAdvisorCard } from "../insight-advisor-card";
import type { InsightResult } from "@/lib/ai/types";

function buildInsight(overrides: Partial<InsightResult> = {}): InsightResult {
  return {
    insightType: "general",
    summary: "All good",
    classification: "gut",
    classificationLabel: "Good",
    findings: [
      {
        label: "Heart rate stable",
        value: "72 bpm",
        assessment: "positive",
      },
    ],
    correlations: [],
    primaryRecommendation: "Keep going",
    recommendations: [],
    dataQuality: {
      coverage: "good",
      gaps: [],
      confidence: "hoch",
    },
    disclaimer: "Not a substitute for medical advice.",
    ...overrides,
  };
}

function render(insight: InsightResult) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <InsightAdvisorCard title="Test card" insight={insight} />
    </I18nProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("<InsightAdvisorCard> — inline chart tokens", () => {
  it("renders an inline HealthChart for an allowlisted token in summary", () => {
    const html = render(
      buildInsight({
        summary: "BP looking great metric:BLOOD_PRESSURE_SYS today",
      }),
    );

    // Chart is rendered with the token's metric as the type.
    expect(html).toContain('data-testid="health-chart"');
    expect(html).toContain('data-types="BLOOD_PRESSURE_SYS"');

    // Token literal is stripped from the visible prose.
    expect(html).not.toContain("metric:BLOOD_PRESSURE_SYS");

    // Surrounding prose survives unchanged.
    expect(html).toContain("BP looking great");
    expect(html).toContain("today");
  });

  it("drops hallucinated tokens silently and still strips the literal", () => {
    const html = render(
      buildInsight({
        summary: "metric:NUKE try this",
      }),
    );

    // No chart rendered.
    expect(html).not.toContain('data-testid="health-chart"');

    // Token literal is gone from the DOM.
    expect(html).not.toContain("metric:NUKE");

    // Visible text is the surrounding prose only.
    expect(html).toContain("try this");
  });

  it("treats injection attempts as plain text — no script, no markup", () => {
    const html = render(
      buildInsight({
        summary: "metric:WEIGHT' onclick='alert(1)'",
      }),
    );

    // The chart still renders for the safe metric prefix.
    expect(html).toContain('data-testid="health-chart"');
    expect(html).toContain('data-types="WEIGHT"');

    // The trailing junk is preserved as escaped text — no script tag,
    // no live `onclick` attribute survives the React text path.
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/<[^>]*\sonclick\s*=/i);

    // The escaped remnant still appears in the prose so the user can see
    // what the model emitted (alert(1) is now inert HTML-encoded text).
    expect(html).toContain("alert(1)");
  });

  it("renders an inline chart attached to a hero finding token", () => {
    const html = render(
      buildInsight({
        findings: [
          {
            label: "Pulse trending down metric:PULSE",
            value: "68 bpm",
            assessment: "positive",
          },
        ],
      }),
    );

    expect(html).toContain('data-types="PULSE"');
    expect(html).not.toContain("metric:PULSE");
    expect(html).toContain("Pulse trending down");
  });

  it("renders inline charts for secondary findings without leaking tokens", () => {
    const html = render(
      buildInsight({
        findings: [
          {
            label: "Hero finding",
            value: "120/80",
            assessment: "neutral",
          },
          {
            label: "Weight stable metric:WEIGHT",
            value: "82 kg",
            assessment: "positive",
          },
        ],
      }),
    );

    expect(html).toContain('data-types="WEIGHT"');
    expect(html).not.toContain("metric:WEIGHT");
    expect(html).toContain("Weight stable");
  });
});
