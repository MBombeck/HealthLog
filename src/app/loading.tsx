/**
 * v1.8.3 — root-level loading skeleton (dashboard segment + any top-level
 * route without its own `loading.tsx`).
 *
 * Defense-in-depth for the navigation-freeze class: a segment that streams
 * paints this skeleton instead of a blank frame. More specific segments
 * (e.g. `/insights`) provide their own skeleton and take precedence.
 *
 * v1.16.1 — the silhouette now mirrors the dashboard's own in-page loading
 * phase instead of a generic card grid. Pre-fix this fallback painted six
 * EMPTY `bg-card` rectangles in a 3-column grid; the dashboard then swapped
 * to its structured `<TrendCardSkeleton>` strip + `<ChartSkeleton>` band, so
 * the very first frame a user saw was a flash of bare dark cards followed by
 * a layout jump. The fix reuses the exact same silhouette components and the
 * same auto-fit grid track (`repeat(auto-fit, minmax(min(100%, 11rem), 1fr))`)
 * as `src/app/page.tsx` — ONE skeleton source for every load phase, zero
 * intermediate "empty card" state, zero footprint change at swap time.
 */
import { ChartSkeleton } from "@/components/charts/chart-skeleton";
import { TrendCardSkeleton } from "@/components/charts/trend-card-skeleton";
import { oneRowItemClass } from "@/components/dashboard/tiles/one-row";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DASHBOARD_WIDGET_IDS,
  DEFAULT_DASHBOARD_LAYOUT,
} from "@/lib/dashboard-layout";

/**
 * Default-layout visible web tiles. The page's own skeleton phase keys its
 * silhouette count off the user's resolved layout (`configuredTileCount` in
 * `src/app/page.tsx`); this fallback paints before any user data exists, so
 * the default layout is the best available guess — and the two counts agree
 * for any account that has not trimmed the strip in Settings → Dashboard.
 * Same filter expression as the page: web-known ids only, `tileVisible`
 * falling back to the legacy `visible` flag.
 */
const webWidgetIds = new Set<string>(DASHBOARD_WIDGET_IDS);
const DEFAULT_TILE_COUNT = DEFAULT_DASHBOARD_LAYOUT.widgets.filter(
  (w) => webWidgetIds.has(w.id) && (w.tileVisible ?? w.visible),
).length;

export default function RootLoading() {
  return (
    <div data-slot="dashboard-loading" className="space-y-6">
      {/* Header row — title + welcome line, mirroring the dashboard hero
          (`text-2xl` heading + `text-sm` subtitle). */}
      <div>
        <Skeleton className="h-8 w-44 rounded" />
        <Skeleton className="mt-2 h-4 w-64 rounded" />
      </div>
      {/* Tile strip — same auto-fit grid track + structured silhouettes as
          the in-page `data-slot="dashboard-tile-strip-skeleton"` phase. */}
      <div
        aria-hidden="true"
        data-slot="dashboard-tile-strip-skeleton"
        className="@container grid auto-rows-fr [grid-template-columns:repeat(auto-fit,minmax(min(100%,11rem),1fr))] gap-3"
      >
        {/* One row, as the closed strip shows it (`one-row.ts`). */}
        {Array.from({ length: DEFAULT_TILE_COUNT }).map((_, i) => (
          <TrendCardSkeleton
            key={`tile-skeleton-${i}`}
            className={oneRowItemClass(i)}
          />
        ))}
      </div>
      {/* Chart band — the first chart cell's silhouette (header row + range
          tabs + chart area), identical to the reveal-gated cells' overlay. */}
      <ChartSkeleton />
    </div>
  );
}
