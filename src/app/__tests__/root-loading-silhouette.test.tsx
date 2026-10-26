import { dashboardSource } from "@/__tests__/helpers/dashboard-source";
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { I18nProvider } from "@/lib/i18n/context";
import RootLoading from "../loading";
import {
  DASHBOARD_WIDGET_IDS,
  DEFAULT_DASHBOARD_LAYOUT,
} from "@/lib/dashboard-layout";

/**
 * v1.16.1 — root loading fallback renders the structured dashboard
 * silhouette, not bare cards.
 *
 * The first frame a user sees on a cold dashboard load is this fallback
 * (it streams before the page mounts and before any query resolves).
 * Pre-fix it painted six EMPTY `bg-card` rectangles in a generic
 * 3-column grid; the page then swapped to its structured
 * `<TrendCardSkeleton>` strip + `<ChartSkeleton>` band — a visible
 * "empty dark cards → skeletons" two-step with a layout jump in
 * between. These tests pin the fallback to the SAME silhouette
 * components and the SAME grid track the page's own loading phase
 * uses, so every phase of the first paint shows one consistent
 * structure.
 */

const GRID_TRACK =
  "[grid-template-columns:repeat(auto-fit,minmax(min(100%,11rem),1fr))]";

// Same expression the fallback (and, per-user, the page) uses to size
// the silhouette strip: web-known widget ids, tileVisible falling back
// to the legacy visible flag.
const webWidgetIds = new Set<string>(DASHBOARD_WIDGET_IDS);
const expectedTileCount = DEFAULT_DASHBOARD_LAYOUT.widgets.filter(
  (w) => webWidgetIds.has(w.id) && (w.tileVisible ?? w.visible),
).length;

function renderMarkup(): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <RootLoading />
    </I18nProvider>,
  );
}

describe("RootLoading — structured dashboard silhouette (SSR markup)", () => {
  it("renders one structured trend-card silhouette per default-visible web tile", () => {
    const markup = renderMarkup();
    const tiles = markup.match(/data-slot="trend-card-skeleton"/g) ?? [];
    expect(expectedTileCount).toBeGreaterThan(0);
    expect(tiles).toHaveLength(expectedTileCount);
  });

  it("renders the chart-band silhouette", () => {
    const markup = renderMarkup();
    expect(markup).toContain('data-slot="chart-skeleton"');
  });

  it("uses the same auto-fit grid track as the in-page tile strip", () => {
    const markup = renderMarkup();
    expect(markup).toContain(
      "grid-template-columns:repeat(auto-fit,minmax(min(100%,11rem),1fr))",
    );
  });

  it("marks the silhouette strip with the shared tile-strip-skeleton slot", () => {
    const markup = renderMarkup();
    expect(markup).toContain('data-slot="dashboard-tile-strip-skeleton"');
  });

  it("contains no bare empty-card silhouette (every card carries inner skeleton rows)", () => {
    const markup = renderMarkup();
    // The legacy fallback's signature was a card with a single empty
    // h-24 block and no structured rows. The structured silhouettes
    // always carry the headline-value row (`h-[30px]`) inside each
    // card; assert it is present and the legacy block is gone.
    expect(markup).not.toContain("h-24");
    expect(markup).toContain("h-[30px]");
  });
});

describe("RootLoading — single skeleton source (wiring pins)", () => {
  const loadingSrc = readFileSync(
    join(process.cwd(), "src/app/loading.tsx"),
    "utf8",
  );
  const pageSrc = dashboardSource();

  it("imports the same silhouette components the page's loading phase uses", () => {
    expect(loadingSrc).toContain(
      'import { TrendCardSkeleton } from "@/components/charts/trend-card-skeleton"',
    );
    expect(loadingSrc).toContain(
      'import { ChartSkeleton } from "@/components/charts/chart-skeleton"',
    );
    expect(pageSrc).toContain(
      'import { TrendCardSkeleton } from "@/components/charts/trend-card-skeleton"',
    );
  });

  it("shares the grid-track literal with the page so the footprint matches at swap time", () => {
    expect(loadingSrc).toContain(GRID_TRACK);
    expect(pageSrc).toContain(GRID_TRACK);
  });
});
