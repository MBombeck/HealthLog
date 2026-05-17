import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { InsightStatusCard } from "../insight-status-card";

/**
 * v1.4.27 — F16 regression cover. The per-metric status text comes
 * out of the AI provider with a literal `metric:<TYPE>` token (the
 * prompt invites the model to embed one so the mother page can render
 * an inline chart). The sub-page does not mount the chart, so the
 * token used to surface verbatim at the tail of the rendered prose.
 * The card now wraps the text in `stripChartTokens` so cached rows
 * from pre-v1.4.27 still render clean while they roll forward.
 */

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

const baseProps = {
  title: "Pulse",
  icon: null,
  hasProvider: true,
  cached: false,
  updatedAt: null,
};

describe("<InsightStatusCard>", () => {
  it("strips a trailing colon-form metric token from rendered prose", () => {
    const html = render(
      <InsightStatusCard
        {...baseProps}
        text="Your pulse is stable. metric:PULSE"
      />,
    );
    expect(html).toContain("Your pulse is stable.");
    expect(html).not.toContain("metric:PULSE");
  });

  it("strips multiple colon-form tokens scattered through the prose", () => {
    const html = render(
      <InsightStatusCard
        {...baseProps}
        title="Blood pressure"
        text="Systolic averaged 132 metric:BLOOD_PRESSURE_SYS over the last 30 days. metric:BLOOD_PRESSURE_DIA"
      />,
    );
    expect(html).toContain("Systolic averaged 132");
    expect(html).not.toContain("metric:BLOOD_PRESSURE_SYS");
    expect(html).not.toContain("metric:BLOOD_PRESSURE_DIA");
  });

  it("strips the capitalised Metric form (v1.4.25 W5b leak shape)", () => {
    const html = render(
      <InsightStatusCard
        {...baseProps}
        title="Blood pressure"
        text="Your Metric Pressure_Sys is elevated relative to last month."
      />,
    );
    expect(html).not.toContain("Metric Pressure_Sys");
    expect(html).toContain("Your");
    expect(html).toContain("is elevated");
  });

  it("renders ordinary prose unchanged when no tokens are present", () => {
    const html = render(
      <InsightStatusCard {...baseProps} text="Pulse stayed inside the band." />,
    );
    expect(html).toContain("Pulse stayed inside the band.");
  });

  it("renders the no-provider state without touching the strip path", () => {
    const html = render(
      <InsightStatusCard
        {...baseProps}
        hasProvider={false}
        text="ignored when hasProvider is false"
      />,
    );
    expect(html).toContain("Assessment unavailable.");
    expect(html).not.toContain("ignored when hasProvider is false");
  });

  it("renders the empty-text state without crashing on null", () => {
    const html = render(<InsightStatusCard {...baseProps} text={null} />);
    expect(html).toContain("No analysis yet.");
  });

  it("renders the structured skeleton (v1.4.37) when loading instead of a centred spinner", () => {
    const html = render(
      <InsightStatusCard {...baseProps} text={null} loading />,
    );
    // The skeleton mounts the same icon dot, title bar, prose lines,
    // and footer that the loaded card paints so the loading state
    // previews the final geometry instead of pinning the card to a
    // single centred spinner row. The aria-busy + sr-only label
    // preserve the accessible "loading" semantics for assistive
    // tech.
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('data-testid="insight-status-card-loading"');
    expect(html).toContain("Loading");
    // The classic Loader2 + visible "common.loading" copy retired so
    // we do not double-paint the announcement.
    expect(html).not.toContain("animate-spin");
  });
});
