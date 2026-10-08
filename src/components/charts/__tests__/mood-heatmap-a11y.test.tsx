import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { MoodHeatmap } from "../mood-heatmap";

/**
 * 2026-07-17 a11y audit (M2) — mood heatmap day cells are pointer-only SVG
 * `<rect>`s. The keyboard/screen-reader path to the per-day values is a
 * the data table under the grid (v1.42: the same `ChartDataTable` every
 * day-linked chart carries, collapsed until asked for), not focusable rects
 * (a cell subtree nested under the SVG's `role="img"` is pruned from the
 * a11y tree, and per-cell tab stops would flood the keyboard order). This
 * pins that table, each row's date as a link to its day, the aggregate
 * `role="img"` summary, and that the rects stay a pure pointer affordance.
 */
// The grid window is the last `days` days ending today, so seed relative
// dates (UTC-sliced, matching the component) rather than fixed ones that
// would slide out of the window over time.
const dayKey = (offset: number) =>
  new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
const D0 = dayKey(0);
const D1 = dayKey(1);

function render() {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <MoodHeatmap
        cells={{
          [D0]: { date: D0, score: 4.2, samples: 2 },
          [D1]: { date: D1, score: 2.0, samples: 1 },
        }}
        days={14}
      />
    </I18nProvider>,
  );
}

describe("<MoodHeatmap> — keyboard-reachable day values", () => {
  it("keeps the aggregate role=img summary on the SVG", () => {
    const html = render();
    expect(html).toMatch(/<svg[^>]*role="img"[^>]*aria-label="[^"]+"/);
  });

  it("keeps the day cells a pure pointer affordance (no tab stops)", () => {
    const html = render();
    const rectMatches = html.match(/<rect\b[^>]*>/g) ?? [];
    expect(rectMatches.length).toBeGreaterThan(0);
    for (const rect of rectMatches) {
      expect(rect).not.toContain("tabindex");
    }
  });

  it("exposes each logged day, and its day, through the data table", () => {
    const html = render();
    const table = html.match(
      /<div[^>]*data-slot="chart-data-table"[^>]*>([\s\S]*?)<\/table>/,
    );
    expect(table).not.toBeNull();
    const rows = table![1].match(/data-slot="chart-data-table-row"/g) ?? [];
    // One row per logged day — the two seeded days, not every cell.
    expect(rows.length).toBe(2);
    expect(table![1]).toContain("4.2");
    expect(table![1]).toContain("2.0");
    // Each date opens its day: the keyboard way to the day a click opens.
    expect(table![1]).toContain(`data-day="${D0}"`);
    expect(table![1]).toContain(`data-day="${D1}"`);
    expect(table![1]).toMatch(/data-slot="day-link"/);
  });
});
