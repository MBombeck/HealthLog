import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import {
  SleepStageStackedBar,
  type SleepStageBreakdown,
} from "../sleep-stage-stacked-bar";

/**
 * v1.4.25 W4c — sleep-stage composition chart unit tests.
 *
 * The chart relies on Recharts which uses `ResponsiveContainer` —
 * `renderToStaticMarkup` produces SSR-only HTML so we assert the
 * surrounding card chrome (heading, aria-label) rather than the
 * Recharts-rendered `<rect>` nodes. That keeps the tests resilient to
 * Recharts version bumps while still covering the prose contract the
 * sub-page depends on.
 */

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

describe("<SleepStageStackedBar>", () => {
  it("renders the composition title with the nights count", () => {
    const breakdown: SleepStageBreakdown = {
      windowDays: 30,
      nights: 23,
      totalMinutes: 460,
      stages: { DEEP: 60, REM: 110, CORE: 230, AWAKE: 30, IN_BED: 30 },
    };

    const html = render(<SleepStageStackedBar breakdown={breakdown} />);
    expect(html).toContain("Stage composition");
    expect(html).toContain("Last 23 nights");
  });

  it("exposes an accessible label that announces the nights covered", () => {
    const breakdown: SleepStageBreakdown = {
      windowDays: 30,
      nights: 14,
      totalMinutes: 100,
      stages: { CORE: 100 },
    };
    const html = render(<SleepStageStackedBar breakdown={breakdown} />);
    expect(html).toMatch(/aria-label="Sleep stage composition over 14 nights"/);
  });

  it("renders German labels under the de locale", () => {
    const breakdown: SleepStageBreakdown = {
      windowDays: 30,
      nights: 7,
      totalMinutes: 200,
      stages: { DEEP: 200 },
    };
    const html = render(<SleepStageStackedBar breakdown={breakdown} />, "de");
    expect(html).toContain("Phasen-Verteilung");
    expect(html).toContain("Letzte 7 Nächte");
  });

  it("does not crash when the breakdown carries unknown stage keys", () => {
    const breakdown: SleepStageBreakdown = {
      windowDays: 30,
      nights: 3,
      totalMinutes: 200,
      stages: { DEEP: 100, UNKNOWN_STAGE: 100 },
    };
    expect(() =>
      render(<SleepStageStackedBar breakdown={breakdown} />),
    ).not.toThrow();
  });
});
