import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import {
  SleepStageStackedBar,
  STAGE_ORDER,
  buildCompositionRows,
  compositionTotals,
  windowHasNap,
  type SleepStageBreakdown,
  type SleepStageNight,
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

// v1.42 — the chart's row of day dots reads the day index through
// react-query, so the static render carries a client (it never fetches).
function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider initialLocale={locale}>{node}</I18nProvider>
    </QueryClientProvider>,
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
    // The title routes through the canonical tile header rather than a
    // hand-rolled title row (UI-STANDARDS §1 / §8).
    expect(html).toContain('data-slot="tile-header"');
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
    // The window toggle speaks the app's range vocabulary, not "7d".
    expect(html).toContain(">7T<");
    expect(html).not.toContain(">7d<");
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
   * v1.15.18 — IN_BED is the TOTAL time in bed (≈ CORE + DEEP + REM +
   * AWAKE), not a sleep PHASE. Stacking it doubled every bar and inflated
   * the tooltip per-night total. It must not be a stack segment.
   */
  describe("IN_BED is not double-counted in the stack (v1.15.18)", () => {
    it("excludes IN_BED from the stacked phase order", () => {
      expect(STAGE_ORDER).not.toContain("IN_BED");
      // The genuine phases (+ the legacy ASLEEP bucket) still stack.
      expect(STAGE_ORDER).toEqual(["DEEP", "REM", "CORE", "ASLEEP", "AWAKE"]);
    });

    it("the per-night stack total is CORE + DEEP + REM + AWAKE, not the inflated IN_BED-inclusive sum", () => {
      // The tooltip sums `payload.reduce` over exactly the stacked series.
      // With IN_BED out of STAGE_ORDER it is no longer a Bar, so it cannot
      // enter the payload and the total self-corrects to the real night.
      const night = { CORE: 240.7, DEEP: 70.6, REM: 90.6, AWAKE: 34.9 };
      const IN_BED = 436.7; // the reported total in bed
      const stackedTotal = STAGE_ORDER.reduce(
        (sum, stage) => sum + ((night as Record<string, number>)[stage] ?? 0),
        0,
      );
      // Sums to the true night (~6 h 56 m), close to the real IN_BED total,
      // and crucially NOT IN_BED + phases (~14 h) the old stack produced.
      expect(stackedTotal).toBeCloseTo(436.8, 1);
      expect(stackedTotal).toBeLessThan(IN_BED + 1);
      expect(stackedTotal).not.toBeCloseTo(IN_BED + stackedTotal, 1);
    });

    it("does not stack IN_BED even when the payload carries it", () => {
      // A night whose breakdown includes the IN_BED total must render the
      // phase bars only; the chart must still mount without IN_BED dominating.
      const breakdown: SleepStageBreakdown = {
        windowDays: 30,
        nights: 1,
        totalMinutes: 437,
        stages: { DEEP: 71, REM: 91, CORE: 241, AWAKE: 35, IN_BED: 437 },
        perNight: [
          {
            dayKey: "2026-06-08",
            stages: { DEEP: 71, REM: 91, CORE: 241, AWAKE: 35, IN_BED: 437 },
          },
        ],
      };
      const html = render(<SleepStageStackedBar breakdown={breakdown} />);
      expect(html).toContain('data-slot="sleep-stage-stacked-bar"');
    });
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

describe("nap band", () => {
  /**
   * Recharts draws nothing under `renderToStaticMarkup`, so the band itself
   * is pinned through the pure row builder the chart feeds.
   */
  const label = (dayKey: string) => dayKey;

  it("carries the nap minutes on the day that has one", () => {
    const perNight: SleepStageNight[] = [
      { dayKey: "2026-06-03", stages: { CORE: 250, DEEP: 50 } },
      {
        dayKey: "2026-06-04",
        stages: { CORE: 250, DEEP: 50 },
        napMinutes: 110,
        napCount: 1,
      },
    ];
    const { rows } = buildCompositionRows(perNight, 7, label);
    expect(rows[1].NAP).toBe(110);
    expect(rows[1].napCount).toBe(1);
    // The night's own stages are untouched by the nap sitting beside them.
    expect(rows[1].CORE).toBe(250);
    // And the day before, which had no nap, carries nothing.
    expect(rows[0].NAP).toBe(0);
    expect(windowHasNap(rows)).toBe(true);
  });

  it("mounts no band at all on a week without a nap", () => {
    const perNight: SleepStageNight[] = [
      { dayKey: "2026-06-03", stages: { CORE: 250, DEEP: 50 } },
      { dayKey: "2026-06-04", stages: { CORE: 260, DEEP: 40 } },
    ];
    const { rows } = buildCompositionRows(perNight, 7, label);
    expect(windowHasNap(rows)).toBe(false);
  });

  /**
   * The tooltip footer used to label a single night's total "Average per
   * night" — the orphaned title of a headline card dropped in v1.22.0. The
   * footer now says what the figure is: the main sleep session, with a
   * second "total" line on days a nap rides on top (issue #611's
   * Main sleep / Naps / Total sleep shape). Recharts renders no tooltip
   * under SSR, so the split is pinned through the pure totals helper the
   * tooltip reads.
   */
  it("totals the main session and the whole day separately when a nap rides on the column", () => {
    const perNight: SleepStageNight[] = [
      {
        dayKey: "2026-06-04",
        stages: { CORE: 250, DEEP: 50, AWAKE: 20 },
        napMinutes: 80,
        napCount: 1,
      },
    ];
    const { rows } = buildCompositionRows(perNight, 7, label);
    const totals = compositionTotals(rows[0]);
    // The main figure is the night column alone — the nap never leaks in,
    // so the per-stage percentages keep meaning "of this night".
    expect(totals.nightMinutes).toBe(320);
    expect(totals.napMinutes).toBe(80);
    // The day line is the whole drawn column: night plus nap.
    expect(totals.dayMinutes).toBe(400);
  });

  it("collapses the totals to the night alone on a day without a nap", () => {
    const perNight: SleepStageNight[] = [
      { dayKey: "2026-06-03", stages: { CORE: 250, DEEP: 50 } },
    ];
    const { rows } = buildCompositionRows(perNight, 7, label);
    const totals = compositionTotals(rows[0]);
    expect(totals.nightMinutes).toBe(300);
    expect(totals.napMinutes).toBe(0);
    // No second line to render — the day IS the night.
    expect(totals.dayMinutes).toBe(300);
  });

  it("drops the band when the nap falls outside the visible window", () => {
    // The nap is on the oldest day; a 2-day window scrolls past it, so the
    // legend must not keep a nap entry the user cannot see.
    const perNight: SleepStageNight[] = [
      {
        dayKey: "2026-06-02",
        stages: { CORE: 250 },
        napMinutes: 110,
        napCount: 1,
      },
      { dayKey: "2026-06-03", stages: { CORE: 250 } },
      { dayKey: "2026-06-04", stages: { CORE: 260 } },
    ];
    expect(windowHasNap(buildCompositionRows(perNight, 3, label).rows)).toBe(
      true,
    );
    expect(windowHasNap(buildCompositionRows(perNight, 2, label).rows)).toBe(
      false,
    );
  });
});
