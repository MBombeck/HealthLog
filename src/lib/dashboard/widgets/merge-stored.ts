/**
 * The layout a dashboard-layout save stores: what the client sent, with
 * every omitted client-owned field carried forward from the stored layout
 * instead of clamped to a default.
 *
 * The disposition map is exhaustive over `DashboardLayout`, so adding a
 * field requires an explicit merge decision. One stored-layout read covers
 * every fallback. The read is skipped only when the client supplied every
 * preserved field and every supplied chart preference has rangePoints.
 */
import { prisma } from "@/lib/db";
import {
  CHART_OVERLAY_KEYS,
  layoutNeedsPreserveRead,
  mergePreservedLayoutFields,
  resolveDashboardLayout,
  serializeDashboardLayout,
  type DashboardLayout,
} from "@/lib/dashboard-layout";

export async function layoutToStore(
  userId: string,
  incoming: Partial<DashboardLayout>,
): Promise<DashboardLayout> {
  let toSerialize = incoming;
  const incomingChartOverlayPrefs = toSerialize.chartOverlayPrefs;
  const needsRangePointsPreserve =
    incomingChartOverlayPrefs !== undefined &&
    CHART_OVERLAY_KEYS.some((chartKey) => {
      const prefs = incomingChartOverlayPrefs[chartKey];
      return prefs !== undefined && prefs.rangePoints === undefined;
    });
  const needsPreserveRead =
    layoutNeedsPreserveRead(toSerialize) || needsRangePointsPreserve;
  if (needsPreserveRead) {
    const existing = await prisma.user.findUnique({
      where: { id: userId },
      select: { dashboardWidgetsJson: true },
    });
    const existingLayout = resolveDashboardLayout(
      existing?.dashboardWidgetsJson,
    );
    toSerialize = mergePreservedLayoutFields(toSerialize, existingLayout);

    if (needsRangePointsPreserve && toSerialize.chartOverlayPrefs) {
      let mergedChartOverlayPrefs = toSerialize.chartOverlayPrefs;
      for (const chartKey of CHART_OVERLAY_KEYS) {
        const incomingPrefs = toSerialize.chartOverlayPrefs[chartKey];
        const storedRangePoints =
          existingLayout.chartOverlayPrefs?.[chartKey]?.rangePoints;
        if (
          incomingPrefs !== undefined &&
          incomingPrefs.rangePoints === undefined &&
          storedRangePoints !== undefined
        ) {
          if (mergedChartOverlayPrefs === toSerialize.chartOverlayPrefs) {
            mergedChartOverlayPrefs = { ...toSerialize.chartOverlayPrefs };
          }
          mergedChartOverlayPrefs[chartKey] = {
            ...incomingPrefs,
            rangePoints: storedRangePoints,
          };
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
