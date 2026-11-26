import type { DashboardWidgetId } from "@/lib/dashboard-layout";

/**
 * Widget ids that actually paint a tile in the strip on the
 * web dashboard, mirrored from the strip tiles (`STRIP_TILES`).
 * `medications` / `recentWorkouts` / `achievements` carry NO strip tile
 * (chart-row cards only), and the iOS-pin-only ids have no web render
 * path at all — counting any of them over-reserved the loading
 * silhouette and made the strip reshuffle when the data landed.
 */
export const TILE_CAPABLE_WIDGET_IDS = [
  "weight",
  "bp",
  "pulse",
  "bodyFat",
  "mood",
  "sleep",
  "steps",
  "glucose",
  "bpInTarget",
  "vo2Max",
  // Vitals + body-composition strip tiles: each paints one
  // strip card and self-gates on having a sample of its MeasurementType.
  "hrv",
  "oxygenSaturation",
  "respiratoryRate",
  "wristTemperature",
  "muscleMass",
  "totalBodyWater",
  "boneMass",
  // Fluid intake strip tile: paints one strip card and self-gates
  // on having a NUTRIENT_WATER sample.
  "waterIntake",
  // Energy intake: one strip card, self-gates on NUTRIENT_ENERGY.
  "energyIntake",
] as const satisfies readonly DashboardWidgetId[];

export type TileCapableWidgetId = (typeof TILE_CAPABLE_WIDGET_IDS)[number];
