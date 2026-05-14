import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import {
  SleepStageStackedBar,
  type SleepStageBreakdown,
} from "../sleep-stage-stacked-bar";

/**
 * v1.4.25 W4c / W3f — sleep-stage stacked-bar chart unit tests.
 *
 * The chart relies on Recharts which uses `ResponsiveContainer` —
 * `renderToStaticMarkup` produces SSR-only HTML so we assert the
 * surrounding card chrome (heading, aria-label, window toggle, empty
 * state) rather than the Recharts-rendered `<rect>` nodes. That keeps
 * the tests resilient to Recharts version bumps while still covering
 * the prose contract the sub-page depends on.
 *
 * v1.4.25 W3f migrated the chart from "30-day average composition" to
 * "per-night stacked bars with 7/14/30d toggle". The tests now pin:
 *   - 7-day default window + toggle button rendering
 *   - Per-night dataset slicing (perNight branch)
 *   - Empty-state when neither perNight nor aggregate has data
 *   - Graceful degradation when perNight is absent (legacy aggregate
 *     path stays render-safe)
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
      perNight: [
        {
          dayKey: "2026-05-08",
          stages: { DEEP: 60, REM: 110, CORE: 230, AWAKE: 30, IN_BED: 30 },
        },
      ],
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
      perNight: [{ dayKey: "2026-05-08", stages: { CORE: 100 } }],
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
      perNight: [{ dayKey: "2026-05-08", stages: { DEEP: 200 } }],
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
      perNight: [
        { dayKey: "2026-05-08", stages: { DEEP: 100, UNKNOWN_STAGE: 100 } },
      ],
    };
    expect(() =>
      render(<SleepStageStackedBar breakdown={breakdown} />),
    ).not.toThrow();
  });

  /**
   * v1.4.25 W3f — per-night surface + window toggle.
   */
  describe("per-night + window toggle (v1.4.25 W3f)", () => {
    it("renders three window-toggle buttons (7 / 14 / 30 days) with 7d active by default", () => {
      const breakdown: SleepStageBreakdown = {
        windowDays: 30,
        nights: 7,
        totalMinutes: 3000,
        stages: { DEEP: 600, REM: 700, CORE: 1500, AWAKE: 200 },
        perNight: Array.from({ length: 7 }, (_, i) => ({
          dayKey: `2026-05-0${i + 1}`,
          stages: { DEEP: 60, REM: 110, CORE: 230, AWAKE: 30 },
        })),
      };
      const html = render(<SleepStageStackedBar breakdown={breakdown} />);
      expect(html).toContain('data-slot="sleep-stage-window-toggle"');
      expect(html).toContain('data-slot="sleep-stage-window-7"');
      expect(html).toContain('data-slot="sleep-stage-window-14"');
      expect(html).toContain('data-slot="sleep-stage-window-30"');
      // The 7d button is default-active.
      expect(html).toMatch(
        /data-slot="sleep-stage-window-7"[^>]*aria-pressed="true"/,
      );
      expect(html).toMatch(
        /data-slot="sleep-stage-window-14"[^>]*aria-pressed="false"/,
      );
    });

    it("renders an empty-state caption when the user has no per-night data", () => {
      const breakdown: SleepStageBreakdown = {
        windowDays: 30,
        nights: 0,
        totalMinutes: 0,
        stages: {},
        perNight: [],
      };
      const html = render(<SleepStageStackedBar breakdown={breakdown} />);
      expect(html).toContain('data-slot="sleep-stage-empty"');
      // No img-role wrapper when the chart is in empty state.
      expect(html).not.toMatch(/role="img"\s+aria-label="Sleep stage/);
    });

    it("degrades gracefully when perNight is absent (legacy payload)", () => {
      // Pre-W3f payloads don't carry perNight. The chart should still
      // render the aggregate as a single bar so the user isn't left
      // staring at an empty card during the rollout.
      const breakdown: SleepStageBreakdown = {
        windowDays: 30,
        nights: 21,
        totalMinutes: 9000,
        stages: { DEEP: 1500, REM: 2000, CORE: 5000, AWAKE: 500 },
      };
      const html = render(<SleepStageStackedBar breakdown={breakdown} />);
      // No empty-state surface because the aggregate still has data.
      expect(html).not.toContain('data-slot="sleep-stage-empty"');
      // The chart card still mounts.
      expect(html).toContain('data-slot="sleep-stage-stacked-bar"');
    });

    it("handles missing-some-nights gracefully (sparse perNight series)", () => {
      // The 7-day window should render even if perNight has gaps —
      // each entry stands alone.
      const breakdown: SleepStageBreakdown = {
        windowDays: 30,
        nights: 4,
        totalMinutes: 2000,
        stages: { DEEP: 400, REM: 500, CORE: 1000, AWAKE: 100 },
        perNight: [
          { dayKey: "2026-05-02", stages: { DEEP: 100, REM: 150, CORE: 300 } },
          { dayKey: "2026-05-04", stages: { DEEP: 100, REM: 150, CORE: 200 } },
          { dayKey: "2026-05-06", stages: { DEEP: 100, REM: 100, CORE: 200 } },
          { dayKey: "2026-05-08", stages: { DEEP: 100, REM: 100, CORE: 300 } },
        ],
      };
      expect(() =>
        render(<SleepStageStackedBar breakdown={breakdown} />),
      ).not.toThrow();
      const html = render(<SleepStageStackedBar breakdown={breakdown} />);
      // Chart still mounts + window toggle present.
      expect(html).toContain('data-slot="sleep-stage-stacked-bar"');
      expect(html).toContain('data-slot="sleep-stage-window-toggle"');
    });
  });
});
