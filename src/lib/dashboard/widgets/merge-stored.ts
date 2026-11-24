/**
 * The layout a dashboard-layout save stores: what the client sent, with
 * every omitted client-owned field carried forward from the stored layout
 * instead of clamped to a default.
 *
 * The disposition map is exhaustive over `DashboardLayout`, so adding a
 * field requires an explicit merge decision. One stored-layout read covers
 * every fallback. The read is skipped only when the client supplied every
 * preserved field and every supplied chart preference has every field in
 * `PRESERVED_CHART_FIELDS`.
 */
import { prisma } from "@/lib/db";
import {
  layoutNeedsPreserveRead,
  mergePreservedLayoutFields,
  resolveDashboardLayout,
  serializeDashboardLayout,
  type DashboardLayout,
} from "@/lib/dashboard-layout";
import { CHART_OVERLAY_KEYS } from "@/lib/dashboard/chart-overlay-prefs";

/**
 * The per-chart fields a client may leave out of a chart's slot without
 * meaning "clear it": an older bundle that predates the field sends the slot
 * without it, and the stored choice is carried forward.
 */
const PRESERVED_CHART_FIELDS = ["rangePoints", "overlayLines"] as const;

export async function layoutToStore(
  userId: string,
  incoming: Partial<DashboardLayout>,
): Promise<DashboardLayout> {
  let toSerialize = incoming;
  const incomingChartOverlayPrefs = toSerialize.chartOverlayPrefs;
  const needsChartFieldPreserve =
    incomingChartOverlayPrefs !== undefined &&
    CHART_OVERLAY_KEYS.some((chartKey) => {
      const prefs = incomingChartOverlayPrefs[chartKey];
      return (
        prefs !== undefined &&
        PRESERVED_CHART_FIELDS.some((field) => prefs[field] === undefined)
      );
    });
  const needsPreserveRead =
    layoutNeedsPreserveRead(toSerialize) || needsChartFieldPreserve;
  if (needsPreserveRead) {
    const existing = await prisma.user.findUnique({
      where: { id: userId },
      select: { dashboardWidgetsJson: true },
    });
    const existingLayout = resolveDashboardLayout(
      existing?.dashboardWidgetsJson,
    );
    toSerialize = mergePreservedLayoutFields(toSerialize, existingLayout);

    if (needsChartFieldPreserve && toSerialize.chartOverlayPrefs) {
      let mergedChartOverlayPrefs = toSerialize.chartOverlayPrefs;
      for (const chartKey of CHART_OVERLAY_KEYS) {
        const incomingPrefs = toSerialize.chartOverlayPrefs[chartKey];
        const storedPrefs = existingLayout.chartOverlayPrefs?.[chartKey];
        if (incomingPrefs === undefined || storedPrefs === undefined) continue;
        let merged = incomingPrefs;
        for (const field of PRESERVED_CHART_FIELDS) {
          if (merged[field] === undefined && storedPrefs[field] !== undefined) {
            merged = { ...merged, [field]: storedPrefs[field] };
          }
        }
        if (merged !== incomingPrefs) {
          if (mergedChartOverlayPrefs === toSerialize.chartOverlayPrefs) {
            mergedChartOverlayPrefs = { ...toSerialize.chartOverlayPrefs };
          }
          mergedChartOverlayPrefs[chartKey] = merged;
        }
      }
      toSerialize = {
        ...toSerialize,
        chartOverlayPrefs: mergedChartOverlayPrefs,
      };
    }
  }
  return serializeDashboardLayout(toSerialize as DashboardLayout);
}
