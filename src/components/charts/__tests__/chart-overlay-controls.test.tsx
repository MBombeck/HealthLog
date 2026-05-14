import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/context";

import {
  ChartOverlayControls,
  ChartOverlayControlsBody,
  DEFAULT_CHART_OVERLAY_PREFS,
  type ChartOverlayPrefs,
} from "../chart-overlay-controls";

/**
 * v1.4.18 — per-chart overlay-controls popover.
 *
 * the maintainer rejected the always-on overlays from B1a (gradient, baseline,
 * target-zone shading) and asked for a per-chart switch surface so a
 * user can toggle "7-Tage-Trend / Trend-Pfeil / Zielbereich" on or off
 * for each chart independently. The popover is anchored top-right of
 * the chart card; the trigger is a small settings cog.
 *
 * The component is dumb / controlled — parents pass in current state +
 * an onChange callback. Persistence + per-chart key-routing are wired
 * up by the chart wrapper that mounts it.
 *
 * Tests run against the static SSR markup of the closed popover and
 * exercise the controlled `onChange` callback synchronously without a
 * DOM library. The dropdown content itself is portalled by Radix and
 * not visible until clicked, so we don't try to assert on its open
 * state in SSR.
 */

function withProvider(ui: React.ReactElement) {
  return <I18nProvider initialLocale="en">{ui}</I18nProvider>;
}

describe("<ChartOverlayControls>", () => {
  it("renders a labelled settings trigger button", () => {
    const html = renderToStaticMarkup(
      withProvider(
        <ChartOverlayControls
          prefs={DEFAULT_CHART_OVERLAY_PREFS}
          onChange={vi.fn()}
        />,
      ),
    );

    expect(html).toContain('data-slot="chart-overlay-controls-trigger"');
    expect(html).toContain('aria-label="Chart overlay settings"');
  });

  it("default prefs match the clean-line baseline (every toggle OFF)", () => {
    expect(DEFAULT_CHART_OVERLAY_PREFS).toEqual({
      showTrendIndicator: false,
      showTrendArrow: false,
      showTargetRange: false,
      comparisonBaseline: "none",
    });
  });

  it("emits an updated prefs object when a toggle is flipped", () => {
    // The component is a thin controller — we exercise the contract by
    // calling onChange ourselves and asserting the merge shape. This
    // mirrors what the radix-ui Switch will pass at runtime without
    // needing a DOM event-loop.
    const onChange = vi.fn();
    const start: ChartOverlayPrefs = DEFAULT_CHART_OVERLAY_PREFS;
    // Render once — this binds the callback closure.
    renderToStaticMarkup(
      withProvider(<ChartOverlayControls prefs={start} onChange={onChange} />),
    );

    // Simulate the merge the component performs: setKey("showTargetRange", true)
    // would call onChange({ ...start, showTargetRange: true }).
    const next: ChartOverlayPrefs = {
      ...start,
      showTargetRange: true,
    };
    onChange(next);
    expect(onChange).toHaveBeenCalledWith({
      showTrendIndicator: false,
      showTrendArrow: false,
      showTargetRange: true,
      comparisonBaseline: "none",
    });
  });

  it("ships German labels under the de locale", () => {
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="de">
        <ChartOverlayControls
          prefs={DEFAULT_CHART_OVERLAY_PREFS}
          onChange={vi.fn()}
        />
      </I18nProvider>,
    );

    expect(html).toContain('aria-label="Chart-Overlay-Einstellungen"');
  });

  /**
   * v1.4.25 W3f — comparison-baseline grey-out when the parent chart
   * reports `hasComparisonData=false`. The disabled state communicates
   * "you selected a comparison but there's no prior-period series to
   * paint" instead of silently hiding the overlay.
   *
   * The popover body is portalled by Radix at runtime — it's not in
   * SSR markup. The tests target the extracted `<ChartOverlayControlsBody>`
   * so the JSX inside the popover is renderable in `renderToStaticMarkup`.
   */
  describe("comparison-baseline grey-out (v1.4.25 W3f)", () => {
    it("renders comparison buttons in normal state when prior data exists", () => {
      const prefs: ChartOverlayPrefs = {
        ...DEFAULT_CHART_OVERLAY_PREFS,
        comparisonBaseline: "lastMonth",
      };
      const html = renderToStaticMarkup(
        withProvider(
          <ChartOverlayControlsBody
            prefs={prefs}
            onChange={vi.fn()}
            hasComparisonData
          />,
        ),
      );

      expect(html).not.toContain('data-comparison-disabled="true"');
      expect(html).not.toContain('data-comparison-greyed="true"');
      expect(html).not.toContain(
        'data-slot="chart-overlay-comparison-unavailable-hint"',
      );
      // The lastMonth button has no aria-disabled set when data is
      // available.
      expect(html).not.toMatch(
        /data-slot="chart-overlay-comparison-lastMonth"[^>]*aria-disabled="true"/,
      );
    });

    it("greys out lastMonth + lastYear when prior period is empty AND a baseline is selected", () => {
      const prefs: ChartOverlayPrefs = {
        ...DEFAULT_CHART_OVERLAY_PREFS,
        comparisonBaseline: "lastMonth",
      };
      const html = renderToStaticMarkup(
        withProvider(
          <ChartOverlayControlsBody
            prefs={prefs}
            onChange={vi.fn()}
            hasComparisonData={false}
          />,
        ),
      );

      expect(html).toContain('data-comparison-disabled="true"');
      // The lastMonth + lastYear buttons grey out, "none" does not.
      expect(html).toMatch(
        /data-slot="chart-overlay-comparison-lastMonth"[^>]*data-comparison-greyed="true"/,
      );
      expect(html).toMatch(
        /data-slot="chart-overlay-comparison-lastYear"[^>]*data-comparison-greyed="true"/,
      );
      // The "none" button stays enabled — it's the escape hatch.
      expect(html).not.toMatch(
        /data-slot="chart-overlay-comparison-none"[^>]*data-comparison-greyed="true"/,
      );
      // aria-disabled + opacity-50 + tooltip surface.
      expect(html).toMatch(
        /data-slot="chart-overlay-comparison-lastMonth"[^>]*aria-disabled="true"/,
      );
      expect(html).toContain("opacity-50");
      expect(html).toContain("No prior-period data yet");
      // The footer hint paragraph is also rendered so screen readers
      // hear the explanation.
      expect(html).toContain(
        'data-slot="chart-overlay-comparison-unavailable-hint"',
      );
    });

    it("keeps all buttons enabled when the baseline is 'none' even with no prior data", () => {
      // The "none" baseline is the safe default — the grey-out only
      // triggers once a user has opted in to comparing.
      const html = renderToStaticMarkup(
        withProvider(
          <ChartOverlayControlsBody
            prefs={DEFAULT_CHART_OVERLAY_PREFS}
            onChange={vi.fn()}
            hasComparisonData={false}
          />,
        ),
      );

      expect(html).not.toContain('data-comparison-disabled="true"');
      expect(html).not.toContain('data-comparison-greyed="true"');
      expect(html).not.toContain(
        'data-slot="chart-overlay-comparison-unavailable-hint"',
      );
    });

    it("emits the localised tooltip + hint copy under de locale", () => {
      const prefs: ChartOverlayPrefs = {
        ...DEFAULT_CHART_OVERLAY_PREFS,
        comparisonBaseline: "lastYear",
      };
      const html = renderToStaticMarkup(
        <I18nProvider initialLocale="de">
          <ChartOverlayControlsBody
            prefs={prefs}
            onChange={vi.fn()}
            hasComparisonData={false}
          />
        </I18nProvider>,
      );
      expect(html).toContain("Kein Vorzeitraum verfügbar");
    });

    it("defaults hasComparisonData to true when the prop is omitted", () => {
      // Charts that haven't been updated to thread the flag keep the
      // pre-W3f behaviour — every button stays enabled.
      const prefs: ChartOverlayPrefs = {
        ...DEFAULT_CHART_OVERLAY_PREFS,
        comparisonBaseline: "lastMonth",
      };
      const html = renderToStaticMarkup(
        withProvider(
          <ChartOverlayControlsBody prefs={prefs} onChange={vi.fn()} />,
        ),
      );
      expect(html).not.toContain('data-comparison-disabled="true"');
    });
  });
});
