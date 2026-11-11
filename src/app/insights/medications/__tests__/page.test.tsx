import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";

/**
 * Insights > Medications: the efficacy summary sits below every medication
 * card and asks one efficacy read per medication. On entry it holds its slot
 * with a sentinel and mounts only when scrolled near, so opening the page
 * sends the cards' reads and not the summary's.
 */

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) =>
    queryKey[1] === "comprehensive"
      ? {
          data: {
            medications: [
              {
                id: "m1",
                name: "Ramipril",
                dose: "5 mg",
                category: "BLOOD_PRESSURE",
                compliance7: 100,
                compliance30: 95,
                streak: 7,
                taken7: 7,
                skipped7: 0,
                missed7: 0,
              },
            ],
          },
          isLoading: false,
          isError: false,
        }
      : { data: undefined, isLoading: false, isError: false },
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ isAuthenticated: true }),
}));
vi.mock("@/hooks/use-ai-capability", () => ({
  useAiCapability: () => ({ available: false }),
  useAiProviderState: () => ({ responseTimeoutMs: null }),
}));
vi.mock("@/components/insights/medication-efficacy-summary", () => ({
  MedicationEfficacySummary: () => <div data-slot="efficacy-summary-mounted" />,
}));
vi.mock("@/components/insights/sub-page-shell", () => ({
  SubPageShell: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/insights/glp1-substance-curve-summary", () => ({
  Glp1SubstanceCurveSummary: () => null,
}));
vi.mock("@/components/insights/metric-target-summary", () => ({
  MetricTargetSummary: () => null,
}));
vi.mock("@/components/insights/insight-status-card", () => ({
  InsightStatusCard: () => null,
}));
vi.mock("@/components/insights/coach-launch-button", () => ({
  CoachLaunchButton: () => null,
}));
vi.mock("@/components/charts/compliance-heatmap", () => ({
  ComplianceHeatmap: () => null,
}));

import { I18nProvider } from "@/lib/i18n/context";
import InsightsMedikamentePage from "../page";

describe("/insights/medications on entry", () => {
  it("renders the cards and holds the efficacy summary until scrolled near", () => {
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <InsightsMedikamentePage />
      </I18nProvider>,
    );

    expect(html).toContain("Ramipril");
    expect(html).toContain('data-deferred-section="medication-efficacy"');
    expect(html).not.toContain("efficacy-summary-mounted");
  });
});
