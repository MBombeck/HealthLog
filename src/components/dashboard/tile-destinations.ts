/**
 * Where each dashboard strip tile leads.
 *
 * A tile shows one metric, and every metric with an Insights sub-page should
 * open it on click. The map is keyed by the tile-capable widget id and typed
 * against the sub-page slug union, so a destination that does not exist is a
 * compile error and a tile added to `TILE_CAPABLE_WIDGET_IDS` without a
 * decision here is one too. `null` means the tile deliberately leads nowhere;
 * the guard in `__tests__/tile-destinations.test.ts` demands a written reason
 * for every such entry and fails when a tile's metric has a sub-page the tile
 * does not open. It exists because the body fat tile was the one tile that
 * led nowhere, documented as having "no dedicated sub-page" while every
 * body-composition sibling had one.
 *
 * A link never points at a page the account cannot see: the destination
 * passes the same `insights-page:<slug>` surface gate the tab strip uses.
 */
import {
  INSIGHTS_OVERVIEW_PATH,
  type SubPageSlug,
} from "@/lib/insights/sub-page-metric";
import { isSurfaceVisible, type SurfaceModuleMap } from "@/lib/modules/surface";

import {
  TILE_CAPABLE_WIDGET_IDS,
  type TileCapableWidgetId,
} from "./dashboard-gates";

export const TILE_DESTINATION: Readonly<
  Record<TileCapableWidgetId, SubPageSlug | null>
> = {
  weight: "weight",
  bp: "blood-pressure",
  pulse: "pulse",
  bodyFat: "body-fat",
  mood: "mood",
  sleep: "sleep",
  steps: "steps",
  glucose: "blood-glucose",
  bpInTarget: "blood-pressure",
  vo2Max: "cardio-fitness",
  hrv: "hrv",
  oxygenSaturation: "oxygen",
  respiratoryRate: "respiratory-rate",
  wristTemperature: "wrist-temperature",
  muscleMass: "muscle-mass",
  totalBodyWater: "body-water",
  boneMass: "bone-mass",
  // Fluid intake lives on the nutrients page (hydration hero + quick-add),
  // not on a Measurement-backed detail page.
  waterIntake: "nutrients",
  energyIntake: "nutrients",
};

const TILE_WIDGET_IDS: ReadonlySet<string> = new Set(TILE_CAPABLE_WIDGET_IDS);

/**
 * The widget a rendered tile belongs to. Blood pressure paints two tiles
 * (`bp-sys`, `bp-dia`) and glucose one per logged context (`glucose-<ctx>`);
 * every other tile carries its widget id verbatim.
 */
export function tileWidgetId(tileId: string): TileCapableWidgetId | null {
  if (tileId === "bp-sys" || tileId === "bp-dia") return "bp";
  if (tileId.startsWith("glucose-")) return "glucose";
  return TILE_WIDGET_IDS.has(tileId) ? (tileId as TileCapableWidgetId) : null;
}

/**
 * The href a rendered tile links to, or null when it has no destination or
 * the destination page is hidden by a switched-off module.
 */
export function dashboardTileHref(
  tileId: string,
  modules: SurfaceModuleMap | null | undefined,
): string | null {
  const widget = tileWidgetId(tileId);
  if (widget === null) return null;
  const slug = TILE_DESTINATION[widget];
  if (slug === null) return null;
  if (!isSurfaceVisible(`insights-page:${slug}`, modules)) return null;
  return `${INSIGHTS_OVERVIEW_PATH}/${slug}`;
}
