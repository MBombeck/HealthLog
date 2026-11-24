import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { TrendTile } from "@/components/ui/trend-tile";

/**
 * v1.16.0 — structured loading silhouette for one dashboard trend tile.
 *
 * Mirrors the real `<TrendCard>` chrome row-for-row (heading row with
 * label + icon slot, headline value row, the `min-h-[18px]` callout
 * reservation, the bottom 7d / 30d sub-row) so a cold first paint reads
 * as "content loading" instead of a bare dark card, and the swap to the
 * real tile causes zero layout shift — every reserved row sits at the
 * same y-coordinate the loaded tile paints at.
 *
 * Pre-fix the tile-strip skeleton and the per-tile `<Suspense>` fallback
 * both rendered an EMPTY pulsing card (`min-h-[8rem]` + border, no inner
 * structure); the first-load impression was a grid of blank rectangles.
 *
 * Always `aria-hidden` — the strip-level container announces loading via
 * the chart skeleton's `role="status"` siblings; a per-tile announcement
 * would spam screen readers with one entry per silhouette. Reduced
 * motion is honoured by the `<Skeleton>` primitive
 * (`motion-reduce:animate-none` on every pulsing block).
 */
export function TrendCardSkeleton({ className }: { className?: string }) {
  return (
    <TrendTile
      aria-hidden="true"
      data-slot="trend-card-skeleton"
      // The frame `<TrendCard>` uses, plus the `min-h-[8rem]` floor the
      // legacy empty silhouette reserved.
      className={cn("min-h-[8rem]", className)}
    >
      {/* Heading row: icon + title, the loaded tile's `TileHeader` with its
          two reserved lines (h-10), so the swap does not move the value row. */}
      <div className="flex h-10 items-start gap-2">
        <Skeleton className="size-5 shrink-0" />
        <Skeleton className="mt-0.5 h-4 w-24" />
      </div>
      {/* Headline value row — `text-3xl leading-none` ≈ 30 px, plus the
          unit slot, baseline-aligned exactly like the loaded tile. */}
      <div className="mt-3 flex items-baseline gap-x-1.5">
        <Skeleton className="h-[30px] w-20" />
        <Skeleton className="h-3.5 w-8" />
      </div>
      {/* Callout slot reservation (comparison delta / stale hint). */}
      <div className="mt-1 min-h-[18px]" />
      {/* 7d / 30d sub-row — the sparkline-equivalent bottom block. */}
      <div className="mt-auto flex items-baseline gap-x-3 pt-1">
        <Skeleton className="h-3 w-14" />
        <Skeleton className="h-3 w-14" />
      </div>
    </TrendTile>
  );
}
