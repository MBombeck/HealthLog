/**
 * The order of the dashboard's tiles, and what lets one move up.
 *
 * The tile row shows only as many tiles as fit one row at the current width;
 * the rest wait under "All values". Which tiles make the row is decided here,
 * in this order:
 *
 *   1. the tiles the person pinned in the layout settings, in their saved
 *      order;
 *   2. the tiles with something to say (`TileAttention`), the strongest
 *      reason first, then by saved order;
 *   3. everything else, by saved order.
 *
 * Pure and shared: the snapshot builder publishes the result as
 * `tiles.order` for the native client, and the web dashboard calls the same
 * function with its live layout, so both clients order the row the same way.
 */
import type { DashboardLayout } from "@/lib/dashboard-layout";

/**
 * Why a tile has something to say, strongest first:
 *
 * - `range`: the latest reading lies outside the person's target band (their
 *   own target where they set one, the profile default otherwise);
 * - `change`: the past week moved clearly (a fit of at least 0.7 that adds up
 *   to 5 % of the monthly mean or more);
 * - `today`: a reading arrived on the person's local today.
 */
export const TILE_ATTENTION_REASONS = ["range", "change", "today"] as const;
export type TileAttention = (typeof TILE_ATTENTION_REASONS)[number];

/** Tile widget id to the strongest reason it has something to say. */
export type TileAttentionMap = Partial<Record<string, TileAttention>>;

/**
 * Every tile-switched-on widget id, pinned first, then those with something
 * to say, then the rest; each group by saved order. Widgets whose tile is
 * switched off are left out.
 */
export function orderStripWidgets(
  layout: Pick<DashboardLayout, "widgets">,
  attention: TileAttentionMap | null | undefined,
): string[] {
  const rank = (id: string, pinned: boolean | undefined) => {
    if (pinned) return 0;
    const reason = attention?.[id];
    return reason ? 1 + TILE_ATTENTION_REASONS.indexOf(reason) : 9;
  };
  return layout.widgets
    .filter((w) => w.tileVisible ?? w.visible)
    .map((w) => ({ id: w.id, order: w.order, rank: rank(w.id, w.pinned) }))
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .map((w) => w.id);
}
