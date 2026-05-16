import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Activity } from "lucide-react";

import { TrendCard } from "../trend-card";
import { I18nProvider } from "@/lib/i18n/context";

/**
 * v1.4.29 — mobile tile equal-height contract.
 *
 * On `<sm` viewports each dashboard tile pins to `--tile-h: 140px`
 * via the strip wrapper. The tile-internal callout slot reserves
 * `min-h-[18px]` even when no callout is rendered, and the sub-row
 * pair switches to `flex-nowrap overflow-hidden` so a narrow tile
 * cannot grow vertically.
 *
 * Per R-C §6 this contract pins regardless of which combination of
 * `compareDelta` / `trend7Delta` / sub-rows the tile is rendering.
 */

const RISING = { slope: 0.5, direction: "up" as const, confidence: 0.8 };

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

describe("<TrendCard> mobile tile equal-height contract", () => {
  const baseProps = {
    label: "Pulse",
    latest: 72,
    unit: "bpm",
    avg7: 70,
    avg30: 71,
    icon: Activity,
    slope30: RISING,
  };

  it("renders the callout slot with min-h-[18px] reserved", () => {
    const html = render(<TrendCard {...baseProps} />);
    // The callout slot wrapper sits between value row + sub-rows and
    // reserves a fixed minimum height so sibling tiles don't drift
    // when the callout is absent.
    expect(html).toContain("min-h-[18px]");
  });

  it("clamps the comparison callout to one line at <sm", () => {
    const html = render(
      <TrendCard
        {...baseProps}
        compareBaseline="lastMonth"
        compareDelta={1.2}
      />,
    );
    expect(html).toContain("line-clamp-1");
    expect(html).toContain('data-slot="tile-compare-delta"');
  });

  it("renders the sub-row pair with flex-nowrap + overflow-hidden", () => {
    const html = render(<TrendCard {...baseProps} />);
    expect(html).toContain("flex-nowrap");
    expect(html).toContain("overflow-hidden");
  });
});
