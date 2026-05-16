import React from "react";
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";

vi.mock("next/navigation", () => ({
  usePathname: () => "/insights",
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));

import { InsightsTabStrip } from "../insights-tab-strip";
import type { InsightInputs } from "@/lib/insights/metric-availability";
import type { DataSummary } from "@/lib/analytics/trends";

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

describe("<InsightsTabStrip> — v1.4.31 memo + availability-stability", () => {
  it("is wrapped in React.memo so a re-render with the same prop reference is a no-op", () => {
    // React.memo'd components carry the `$$typeof` Memo tag plus a
    // `compare` field. Probing the type tag is the cheapest way to
    // pin the memo contract without spinning a full React tree.
    const tag = (InsightsTabStrip as unknown as { $$typeof: symbol })
      .$$typeof;
    expect(typeof tag).toBe("symbol");
    expect(tag.toString()).toContain("memo");
  });

  it("renders consistently for a stable availability prop reference", () => {
    const availability: InsightInputs = {
      summaries: { PULSE: fakeSummary(3) },
      hasMood: false,
      hasMedication: false,
    };
    const html1 = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <InsightsTabStrip availability={availability} />
      </I18nProvider>,
    );
    const html2 = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <InsightsTabStrip availability={availability} />
      </I18nProvider>,
    );
    expect(html1).toBe(html2);
  });
});
