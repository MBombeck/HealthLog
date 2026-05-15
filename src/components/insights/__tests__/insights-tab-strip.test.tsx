import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";

// `usePathname` is consulted to mark the active pill; SSR has no
// Next.js router, so we stub it.
vi.mock("next/navigation", () => ({
  usePathname: () => "/insights",
}));

// `toast` is consulted from a falling-edge effect; renderToStaticMarkup
// doesn't fire effects, but we stub it for completeness.
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));

import { InsightsTabStrip } from "../insights-tab-strip";
import type { InsightInputs } from "@/lib/insights/metric-availability";
import type { DataSummary } from "@/lib/analytics/trends";

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

function fakeSummary(count: number): DataSummary {
  return {
    count,
    latest: count > 0 ? 1 : null,
    min: null,
    max: null,
    mean: null,
    avg7: null,
    avg30: null,
    slope7: null,
    slope30: null,
    slope90: null,
    anomalyCount: 0,
  };
}

describe("<InsightsTabStrip> — availability gating (v1.4.27 F19)", () => {
  it("renders every pill when availability is omitted (backward compat)", () => {
    const html = render(<InsightsTabStrip />);
    expect(html).toContain(">Blood Pressure<");
    expect(html).toContain(">Weight<");
    expect(html).toContain(">Pulse<");
    expect(html).toContain(">Mood<");
    expect(html).toContain(">Medication<");
    expect(html).toContain(">BMI<");
    expect(html).toContain(">Sleep<");
  });

  it("drops pills for metrics with zero observations", () => {
    const availability: InsightInputs = {
      summaries: {
        PULSE: fakeSummary(5),
        WEIGHT: fakeSummary(3),
      },
      hasMood: false,
      hasMedication: false,
    };
    const html = render(<InsightsTabStrip availability={availability} />);
    // Pills that have data stay.
    expect(html).toContain(">Pulse<");
    expect(html).toContain(">Weight<");
    expect(html).toContain(">BMI<");
    // Pills without data drop.
    expect(html).not.toContain(">Blood Pressure<");
    expect(html).not.toContain(">Mood<");
    expect(html).not.toContain(">Medication<");
    expect(html).not.toContain(">Sleep<");
  });

  it("keeps the overview pill regardless of availability", () => {
    const availability: InsightInputs = {
      summaries: {},
      hasMood: false,
      hasMedication: false,
    };
    const html = render(<InsightsTabStrip availability={availability} />);
    expect(html).toContain(">Overview<");
  });

  it("lights up Mood when hasMood flips to true", () => {
    const availability: InsightInputs = {
      summaries: {},
      hasMood: true,
      hasMedication: false,
    };
    const html = render(<InsightsTabStrip availability={availability} />);
    expect(html).toContain(">Mood<");
    expect(html).not.toContain(">Medication<");
  });

  it("lights up Medication when hasMedication flips to true", () => {
    const availability: InsightInputs = {
      summaries: {},
      hasMood: false,
      hasMedication: true,
    };
    const html = render(<InsightsTabStrip availability={availability} />);
    expect(html).toContain(">Medication<");
    expect(html).not.toContain(">Mood<");
  });

  it("derives BMI from WEIGHT count", () => {
    const availability: InsightInputs = {
      summaries: { WEIGHT: fakeSummary(2) },
      hasMood: false,
      hasMedication: false,
    };
    const html = render(<InsightsTabStrip availability={availability} />);
    expect(html).toContain(">Weight<");
    expect(html).toContain(">BMI<");
  });
});
