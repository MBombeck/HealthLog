import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Activity } from "lucide-react";

import { TrendCard } from "../trend-card";
import { SleepSourceDiscrepancyMarker } from "@/components/insights/sleep-source-discrepancy-marker";
import { I18nProvider } from "@/lib/i18n/context";

/**
 * v1.5 — metric-aware trend-arrow colour. Each metric tile gets a
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
    expect(html).toContain("text-warning");
  });

  it("paints up-bad metric ↓ as green (improvement)", () => {
    const html = render(
      <TrendCard
        {...baseProps}
        slope30={FALLING}
        directionSentiment="up-bad"
      />,
    );
    expect(html).toContain("text-success");
  });

  it("paints up-good metric ↑ as green", () => {
    const html = render(
      <TrendCard
        {...baseProps}
        slope30={RISING}
        directionSentiment="up-good"
      />,
    );
    expect(html).toContain("text-success");
  });

  // #1006 — weight inside the person's own target band: steady is the win,
  // and a move either way is neither celebrated nor scolded.
  it("paints a hold metric that stayed flat as green", () => {
    const html = render(
      <TrendCard
        {...baseProps}
        slope30={STABLE}
        trend7Delta={0}
        directionSentiment="hold"
      />,
    );
    expect(html).toContain("text-success");
    expect(html).not.toContain("text-warning");
  });

  it("never paints a hold metric orange when it moves", () => {
    for (const slope of [RISING, FALLING]) {
      const html = render(
        <TrendCard {...baseProps} slope30={slope} directionSentiment="hold" />,
      );
      expect(html).not.toContain("text-warning");
      expect(html).not.toContain("text-success");
    }
  });

  it("paints up-good metric ↓ as orange", () => {
    const html = render(
      <TrendCard
        {...baseProps}
        slope30={FALLING}
        directionSentiment="up-good"
      />,
    );
    expect(html).toContain("text-warning");
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
    expect(up).not.toContain("text-success");
    expect(up).not.toContain("text-warning");
    expect(down).toContain("text-muted-foreground");
    expect(down).not.toContain("text-success");
    expect(down).not.toContain("text-warning");
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
    expect(html).not.toContain("text-success");
    expect(html).not.toContain("text-warning");
  });

  it("defaults to neutral when sentiment is omitted (back-compat)", () => {
    const html = render(<TrendCard {...baseProps} slope30={RISING} />);
    expect(html).toContain("text-muted-foreground");
    expect(html).not.toContain("text-success");
    expect(html).not.toContain("text-warning");
  });
});

describe("<TrendCard> value is never truncated", () => {
  // v1.8.7 — the maintainer is emphatic: the numeric value must always
  // render in full at any tile width (dense strip → narrowest column).
  // The value span keeps its full intrinsic width (`shrink-0
  // whitespace-nowrap`) and never carries `truncate`/`min-w-0`; when
  // space is tight the UNIT yields instead. These guards pin the
  // contract so a future layout churn can't reintroduce the clip.
  function valueSpan(html: string): string {
    const marker = 'data-slot="trend-card-value"';
    const idx = html.indexOf(marker);
    expect(idx).toBeGreaterThan(-1);
    // Walk back to the opening "<span" of the value node.
    const open = html.lastIndexOf("<span", idx);
    const close = html.indexOf("</span>", idx);
    return html.slice(open, close);
  }

  it("renders the full BP value (130) — never clipped to '13'", () => {
    const html = render(
      <TrendCard
        label="BP systolic"
        latest={130}
        unit="mmHg"
        avg7={128}
        avg30={129}
        slope30={null}
        icon={Activity}
      />,
    );
    // Value span renders the full reading (formatter adds one decimal).
    expect(valueSpan(html)).toContain("130.0");
  });

  it("renders the full paired BP value (131/85)", () => {
    const html = render(
      <TrendCard
        label="BP"
        latest={131}
        unit="mmHg"
        avg7={130}
        avg30={130}
        slope30={null}
        icon={Activity}
        secondary={{ latest: 85, avg7: 84, avg30: 84 }}
      />,
    );
    expect(valueSpan(html)).toContain("131.0/85.0");
  });

  it("does not put truncate or min-w-0 on the value node", () => {
    const html = render(
      <TrendCard
        label="Weight"
        latest={80.4}
        unit="kg"
        avg7={80}
        avg30={80}
        slope30={null}
        icon={Activity}
      />,
    );
    const value = valueSpan(html);
    expect(value).not.toContain("truncate");
    expect(value).not.toContain("min-w-0");
    // The value holds its width and the number stays on one line.
    expect(value).toContain("shrink-0");
    expect(value).toContain("whitespace-nowrap");
  });

  it("lets the unit yield (min-w-0 truncate) instead of the value", () => {
    const html = render(
      <TrendCard
        label="VO2"
        latest={42}
        unit="mL/(kg·min)"
        avg7={42}
        avg30={42}
        slope30={null}
        icon={Activity}
      />,
    );
    // The unit text renders in full in the markup; the truncate is a
    // density safeguard that only engages when the column is too narrow.
    expect(html).toContain("mL/(kg·min)");
  });
});

describe("<TrendCard> valueAdornment slot", () => {
  // v1.28.x — the dashboard sleep tile passes the discreet source-
  // discrepancy marker into the value row when the server flagged two
  // writers with clearly different totals for the latest night.
  const baseProps = {
    label: "Sleep",
    latest: 10.25,
    unit: "h",
    avg7: 7.5,
    avg30: 7.4,
    slope30: null,
    icon: Activity,
  };

  it("renders the sleep source-discrepancy marker next to the value when present", () => {
    const html = render(
      <TrendCard
        {...baseProps}
        valueAdornment={
          <SleepSourceDiscrepancyMarker
            discrepancy={{
              deltaMinutes: 160,
              sources: [
                { source: "WITHINGS", deviceType: null, asleepMinutes: 615 },
                {
                  source: "APPLE_HEALTH",
                  deviceType: null,
                  asleepMinutes: 455,
                },
              ],
            }}
          />
        }
      />,
    );
    expect(html).toContain('data-slot="trend-card-value-adornment"');
    expect(html).toContain('data-hint="sleep-source-discrepancy"');
  });

  it("renders no adornment slot when the annotation is absent", () => {
    const html = render(<TrendCard {...baseProps} />);
    expect(html).not.toContain('data-slot="trend-card-value-adornment"');
    expect(html).not.toContain('data-hint="sleep-source-discrepancy"');
  });
});

describe("<TrendCard> responsive layout", () => {
  it("keeps long BP target tile content wrappable inside the card", () => {
    // v1.4.28 — the BD-Zielbereich tile dropped `avgAllTime`
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
