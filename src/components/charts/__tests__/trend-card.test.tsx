import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Activity } from "lucide-react";

import { TrendCard } from "../trend-card";
import { I18nProvider } from "@/lib/i18n/context";

/**
 * v1.5 phase-5 — metric-aware trend-arrow colour. Each metric tile gets a
 * `directionSentiment` prop (`up-good` | `up-bad` | `neutral`) so the small
 * up/down arrow next to the latest reading paints semantically:
 *
 *   - mood ↑ green, weight ↑ orange, BP ↑ orange, pulse ↑ muted, etc.
 *
 * Flat ("→") and "no slope yet" ("—") always stay muted regardless of
 * sentiment so we don't celebrate or scold a metric that hasn't moved.
 */

// `TrendSlope` from `src/lib/analytics/trends.ts` — `direction: "up" | "down"
// | "stable"` (not "flat"). The test fixtures mirror that contract.
const RISING = { slope: 0.5, direction: "up" as const, confidence: 0.8 };
const FALLING = { slope: -0.5, direction: "down" as const, confidence: 0.8 };
const STABLE = { slope: 0, direction: "stable" as const, confidence: 0.1 };

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

describe("<TrendCard> directionSentiment", () => {
  const baseProps = {
    label: "Weight",
    latest: 80,
    unit: "kg",
    avg7: 80,
    avg30: 80,
    icon: Activity,
  };

  it("paints up-bad metric ↑ as orange (warning)", () => {
    const html = render(
      <TrendCard {...baseProps} slope30={RISING} directionSentiment="up-bad" />,
    );
    expect(html).toContain("text-dracula-orange");
  });

  it("paints up-bad metric ↓ as green (improvement)", () => {
    const html = render(
      <TrendCard
        {...baseProps}
        slope30={FALLING}
        directionSentiment="up-bad"
      />,
    );
    expect(html).toContain("text-dracula-green");
  });

  it("paints up-good metric ↑ as green", () => {
    const html = render(
      <TrendCard
        {...baseProps}
        slope30={RISING}
        directionSentiment="up-good"
      />,
    );
    expect(html).toContain("text-dracula-green");
  });

  it("paints up-good metric ↓ as orange", () => {
    const html = render(
      <TrendCard
        {...baseProps}
        slope30={FALLING}
        directionSentiment="up-good"
      />,
    );
    expect(html).toContain("text-dracula-orange");
  });

  it("keeps neutral metric arrows muted regardless of direction", () => {
    const up = render(
      <TrendCard
        {...baseProps}
        slope30={RISING}
        directionSentiment="neutral"
      />,
    );
    const down = render(
      <TrendCard
        {...baseProps}
        slope30={FALLING}
        directionSentiment="neutral"
      />,
    );
    expect(up).toContain("text-muted-foreground");
    expect(up).not.toContain("text-dracula-green");
    expect(up).not.toContain("text-dracula-orange");
    expect(down).toContain("text-muted-foreground");
    expect(down).not.toContain("text-dracula-green");
    expect(down).not.toContain("text-dracula-orange");
  });

  it("keeps stable-trend arrows muted even when sentiment is set", () => {
    const html = render(
      <TrendCard
        {...baseProps}
        slope30={STABLE}
        directionSentiment="up-good"
      />,
    );
    // Stable slope = no value judgement; the arrow points sideways.
    expect(html).toContain("text-muted-foreground");
    expect(html).not.toContain("text-dracula-green");
    expect(html).not.toContain("text-dracula-orange");
  });

  it("defaults to neutral when sentiment is omitted (back-compat)", () => {
    const html = render(<TrendCard {...baseProps} slope30={RISING} />);
    expect(html).toContain("text-muted-foreground");
    expect(html).not.toContain("text-dracula-green");
    expect(html).not.toContain("text-dracula-orange");
  });
});

describe("<TrendCard> responsive layout", () => {
  it("keeps long BP target tile content wrappable inside the card", () => {
    // v1.4.28 FB-C2 — the BD-Zielbereich tile dropped `avgAllTime`
    // and the synthetic slope; assert the surviving shape (overflow
    // wrap discipline, compare-delta callout) still ships.
    const html = render(
      <TrendCard
        label="BP in target"
        latest={50}
        unit="%"
        avg7={100}
        avg30={50}
        slope30={null}
        trend7Delta={50}
        icon={Activity}
        directionSentiment="up-good"
        compareBaseline="lastMonth"
        compareDelta={36}
      />,
    );

    expect(html).toContain("min-w-0");
    expect(html).toContain("[overflow-wrap:anywhere]");
    expect(html).toContain('data-slot="tile-compare-delta"');
    expect(html).not.toContain('data-slot="trend-card-all-time"');
  });
});
