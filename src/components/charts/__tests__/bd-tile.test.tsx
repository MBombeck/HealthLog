import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Target, Activity } from "lucide-react";

import { TrendCard } from "../trend-card";
import { I18nProvider } from "@/lib/i18n/context";

/**
 * v1.4.28 R3a FB-C1 + FB-C2 — BD-Zielbereich tile shape parity.
 *
 * Until v1.4.27 the dashboard mounted the BD tile through a special
 * branch that:
 *   1. Synthesised a fake `slope30 = bpTrendDelta / 30` so the arrow
 *      could move (the result was a small float like 1.1 that the
 *      TrendCard's downstream formatter pipeline could render as
 *      "1.1." — the maintainer's screenshot regression).
 *   2. Passed `avgAllTime` so a third sub-row showed the all-time
 *      percentage — the BD tile was the only consumer of that prop.
 *
 * Both customisations retire in v1.4.28: the BD tile now mounts
 * through the same TrendCard contract as Weight / BP / Pulse and the
 * `avgAllTime*` prop family drops entirely. This spec is the
 * regression lock against the divergent shape returning.
 */

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

describe("BD-Zielbereich tile (v1.4.28 FB-C1/C2 rewrite)", () => {
  it("renders a numeric percent headline, never a date-shaped literal", () => {
    const html = render(
      <TrendCard
        label="BP in target"
        latest={87}
        unit="%"
        avg7={90}
        avg30={87}
        slope30={null}
        trend7Delta={3}
        icon={Target}
        directionSentiment="up-good"
      />,
    );
    // The headline value-row must include "%" and an integer/percent
    // string — never a `d.d.` artefact from the legacy synthetic-slope
    // formatter chain.
    expect(html).toContain('data-slot="trend-card-value-row"');
    const valueRowMatch = html.match(
      /data-slot="trend-card-value-row"[^>]*>([\s\S]*?)<\/div>/,
    );
    expect(valueRowMatch).not.toBeNull();
    const valueText = valueRowMatch![1];
    expect(valueText).toContain("%");
    expect(valueText).not.toMatch(/\d{1,2}\.\d{1,2}\.</);
  });

  it("ships the same DOM shape as the Weight tile (no all-time slot)", () => {
    const bdHtml = render(
      <TrendCard
        label="BP in target"
        latest={87}
        unit="%"
        avg7={90}
        avg30={87}
        slope30={null}
        trend7Delta={3}
        icon={Target}
        directionSentiment="up-good"
      />,
    );
    const weightHtml = render(
      <TrendCard
        label="Weight"
        latest={75.5}
        unit="kg"
        avg7={76.0}
        avg30={75.8}
        slope30={null}
        trend7Delta={-0.2}
        icon={Activity}
        directionSentiment="up-bad"
      />,
    );

    // Same primitive slots on both tiles.
    for (const slot of [
      "trend-card-value-row",
    ]) {
      expect(bdHtml).toContain(`data-slot="${slot}"`);
      expect(weightHtml).toContain(`data-slot="${slot}"`);
    }

    // The retired all-time slot must NOT render on either tile.
    expect(bdHtml).not.toContain('data-slot="trend-card-all-time"');
    expect(weightHtml).not.toContain('data-slot="trend-card-all-time"');
  });

  it("renders a dash headline when the metric has no data yet", () => {
    const html = render(
      <TrendCard
        label="BP in target"
        latest={null}
        unit="%"
        avg7={null}
        avg30={null}
        slope30={null}
        icon={Target}
        directionSentiment="up-good"
      />,
    );
    expect(html).toContain('data-slot="trend-card-value-row"');
    expect(html).toContain("—");
  });
});
