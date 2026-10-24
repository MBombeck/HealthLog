import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Activity, Smile } from "lucide-react";

import { TrendCard } from "../trend-card";
import { I18nProvider } from "@/lib/i18n/context";
import { primeLocales } from "@/__tests__/helpers/prime-locales";
import { summarize } from "@/lib/analytics/trends";
import { summaryToTrend7Delta } from "@/lib/analytics/trend-delta";

primeLocales("de");

/**
 * v1.4.15 — "7-Tage-Schnitt" → "7-Tage-Trend".
 *
 * The avg7 line on every dashboard tile used to read "7d: 80.5" /
 * "7T: 80,5" — visually an *average*. the maintainer wanted it to convey
 * *direction* over the past week instead, so the label flips to
 * "7d trend" / "7T-Trend" and a signed delta indicator paints next
 * to the value with metric-aware colour:
 *
 *   - up-bad (BP, weight, body fat) → +delta paints orange
 *   - up-good (mood, sleep, steps)  → +delta paints green
 *   - neutral (pulse, BP-in-target) → muted regardless of sign
 *
 * The legacy "7d:" label is preserved when no `trend7Delta` prop is
 * supplied so call sites that haven't been migrated stay intact.
 */

const RISING = { slope: 0.5, direction: "up" as const, confidence: 0.8 };

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

describe("<TrendCard> 7-day trend label", () => {
  const baseProps = {
    label: "Weight",
    latest: 80,
    unit: "kg",
    avg7: 80,
    avg30: 80,
    slope30: RISING,
    icon: Activity,
  };

  it("paints the trend-label when a 7d delta is supplied (English)", () => {
    const html = render(
      <TrendCard
        {...baseProps}
        trend7Delta={1.2}
        directionSentiment="up-bad"
      />,
    );
    // New label flips on for the trend variant.
    expect(html).toContain("7-day trend");
    // Legacy avg7 short label must NOT appear in the trend variant —
    // this is the whole point of the rename.
    expect(html).not.toContain(">7d:<");
  });

  it("paints the trend-label in German", () => {
    const html = render(
      <TrendCard
        {...baseProps}
        trend7Delta={1.2}
        directionSentiment="up-bad"
      />,
      "de",
    );
    expect(html).toContain("7-Tage-Trend");
  });

  it("keeps the legacy avg7 label when no delta is supplied (back-compat)", () => {
    const html = render(<TrendCard {...baseProps} />);
    expect(html).toContain("7d");
    expect(html).not.toContain("7-day trend");
  });

  it("renders a positive delta with `+` sign and one decimal", () => {
    const html = render(
      <TrendCard
        {...baseProps}
        trend7Delta={1.2}
        directionSentiment="up-bad"
      />,
    );
    expect(html).toContain('data-slot="trend7-delta"');
    expect(html).toContain("+1.2");
  });

  it("renders a negative delta with a minus sign", () => {
    const html = render(
      <TrendCard
        {...baseProps}
        trend7Delta={-0.8}
        directionSentiment="up-bad"
      />,
    );
    // Unicode minus sign is what the formatter emits.
    expect(html).toContain("−0.8");
  });

  it("paints zero/near-zero delta as muted ±0", () => {
    // No slope30 here so the arrow stays muted — the only coloured
    // element that *could* paint sentiment is the delta itself.
    const html = render(
      <TrendCard
        {...baseProps}
        slope30={null}
        trend7Delta={0.01}
        directionSentiment="up-good"
      />,
    );
    expect(html).toContain("±0");
    // Tiny absolute deltas never paint sentiment colour — they read
    // as "no movement" regardless of metric type.
    expect(html).not.toContain("text-success");
    expect(html).not.toContain("text-warning");
  });

  it("colors a +delta orange on an up-bad metric (weight rising = bad)", () => {
    const html = render(
      <TrendCard
        {...baseProps}
        trend7Delta={0.8}
        directionSentiment="up-bad"
      />,
    );
    // The DELTA span uses up-bad sentiment → +delta = orange.
    // We can't easily isolate just the delta element from the rendered
    // HTML, so we assert orange is present in a delta-bearing render.
    // (Tile arrow is muted for stable slope or omitted icon — but the
    // delta paints regardless, so orange must appear.)
    expect(html).toContain("text-warning");
  });

  it("colors a +delta green on an up-good metric (mood rising = good)", () => {
    const html = render(
      <TrendCard
        label="Mood"
        latest={4}
        unit="/ 5"
        avg7={4}
        avg30={4}
        slope30={null}
        icon={Smile}
        directionSentiment="up-good"
        trend7Delta={0.5}
      />,
    );
    expect(html).toContain("text-success");
  });

  it("paints neutral metrics muted regardless of delta direction", () => {
    const html = render(
      <TrendCard
        {...baseProps}
        trend7Delta={2.0}
        directionSentiment="neutral"
      />,
    );
    expect(html).toContain('data-slot="trend7-delta"');
    expect(html).toContain("text-muted-foreground");
    expect(html).not.toContain("text-success");
    expect(html).not.toContain("text-warning");
  });
});

/**
 * The blood-pressure tile read "7-Tage-Trend: 125 (−11.412)" when the
 * week's only readings were one sitting minutes apart: the regression's
 * slope per day exploded and the tile printed seven days of it. The tile is
 * fed the way `strip-tiles.tsx` feeds it, from `summarize()` through
 * `summaryToTrend7Delta()`, so the delta it renders is the one the
 * dashboard would.
 */
describe("<TrendCard> blood-pressure tile after one sitting", () => {
  it("renders the 7-day mean, not a thousands-of-mmHg trend", () => {
    const MINUTE = 60 * 1000;
    const summary = summarize([
      { date: new Date(Date.now() - 10 * MINUTE), value: 130 },
      { date: new Date(Date.now() - 8 * MINUTE), value: 124 },
      { date: new Date(Date.now() - 6 * MINUTE), value: 118 },
    ]);
    const html = render(
      <TrendCard
        label="BD (SYS)"
        latest={summary.latest}
        unit="mmHg"
        fractionDigits={0}
        avg7={summary.avg7}
        avg30={summary.avg30}
        slope30={summary.slope30}
        trend7Delta={summaryToTrend7Delta(summary)}
        icon={Activity}
        directionSentiment="up-bad"
      />,
      "de",
    );
    expect(html).not.toContain('data-slot="trend7-delta"');
    expect(html).not.toContain("7-Tage-Trend");
    expect(html).toContain("7T");
    // No grouped thousands anywhere on the tile.
    expect(html).not.toMatch(/\d\.\d{3}/);
  });
});
