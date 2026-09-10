/**
 * v1.39 (C2) — the dashboard tile order the setup answers imply.
 *
 * "Enables the matching modules and orders the dashboard" (design spec §The
 * questions, Q2): the module half lives in the registry's derivation, this
 * is the ordering half. Each area names the tiles it is about; the seed
 * promotes them to the top of the default layout and forces them visible on
 * both surfaces, and leaves every other tile exactly where the default puts
 * it. A daily medication schedule promotes the medication tile the same way.
 *
 * ONE-TIME, and the caller gates it: the completion route writes the seed
 * only while `User.dashboardWidgetsJson` is still unset, so a person who
 * already arranged their tiles is never clobbered, and a concurrent layout
 * save that lands first wins. Not a clinical target store — targets are
 * derived elsewhere; this only decides what is on top.
 *
 * Replaces the six goal slugs of the five-step wizard, whose only durable
 * effect was this same seed.
 */
import {
  DEFAULT_DASHBOARD_LAYOUT,
  serializeDashboardLayout,
  type DashboardLayout,
  type DashboardWidgetId,
} from "@/lib/dashboard-layout";
import type { OnboardingAreaKey } from "@/lib/modules/registry";

import type { OnboardingNeeds } from "./needs";

/**
 * Area → the tiles to promote. An area whose surface is not a dashboard tile
 * (cycle, labs, illness) maps to nothing; its module is still switched on.
 * Ids must be members of `DASHBOARD_WIDGET_IDS`; the seed never invents one.
 */
export const AREA_WIDGET_SEED_MAP: Readonly<
  Record<OnboardingAreaKey, readonly DashboardWidgetId[]>
> = Object.freeze({
  "blood-pressure": ["bp", "bpInTarget", "pulse"],
  "weight-body": ["weight", "bodyFat"],
  glucose: ["glucose"],
  sleep: ["sleep"],
  mood: ["mood"],
  cycle: [],
  activity: ["steps"],
  labs: [],
  illness: [],
});

/** Q3 "yes" or "sometimes" promotes the medication tile. */
export const MEDICATION_WIDGET_SEED: readonly DashboardWidgetId[] = [
  "medications",
];

/**
 * The tiles the answers promote, in the default layout's order. Empty when
 * the answers speak to no tile, which is the "leave the column unset" case.
 */
export function promotedWidgetsFor(
  needs: Pick<OnboardingNeeds, "areas" | "medication">,
): DashboardWidgetId[] {
  const promoted = new Set<DashboardWidgetId>();
  for (const area of needs.areas) {
    for (const id of AREA_WIDGET_SEED_MAP[area] ?? []) promoted.add(id);
  }
  if (needs.medication === "yes" || needs.medication === "sometimes") {
    for (const id of MEDICATION_WIDGET_SEED) promoted.add(id);
  }
  return DEFAULT_DASHBOARD_LAYOUT.widgets
    .map((w) => w.id as DashboardWidgetId)
    .filter((id) => promoted.has(id));
}

/**
 * Build the seeded layout, or `null` when there is nothing to promote so the
 * caller can skip the write entirely and leave the column unset (the default
 * layout). Every tile keeps its default config; the promoted ones move to the
 * front, in their default relative order, and are forced visible on both
 * surfaces. The result is dense: `order` is 0..n-1 with no tile dropped.
 */
export function buildNeedsSeededDashboardLayout(
  needs: Pick<OnboardingNeeds, "areas" | "medication">,
): DashboardLayout | null {
  const promoted = new Set(promotedWidgetsFor(needs));
  if (promoted.size === 0) return null;

  const base = DEFAULT_DASHBOARD_LAYOUT.widgets;
  const front = base.filter((w) => promoted.has(w.id as DashboardWidgetId));
  const rest = base.filter((w) => !promoted.has(w.id as DashboardWidgetId));

  const ordered = [...front, ...rest].map((w, index) => ({
    ...w,
    ...(promoted.has(w.id as DashboardWidgetId)
      ? { visible: true, tileVisible: true }
      : {}),
    order: index,
  }));

  return serializeDashboardLayout({
    ...DEFAULT_DASHBOARD_LAYOUT,
    widgets: ordered,
  });
}
