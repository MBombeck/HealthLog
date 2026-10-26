/**
 * Which dashboard toggles cannot do anything for this account. Resolved on
 * the server, so the Settings screen never has to fetch dashboard data to
 * find out whether a switch it is about to draw is dead.
 *
 * Deliberately OUTSIDE the cached layout: the layout cell is keyed on the
 * user and holds their arrangement, which does not change when a module is
 * toggled. Folding a module-dependent answer into it would serve a stale one
 * for the rest of the 5-minute TTL — the switch would linger for minutes
 * after Recovery went off, which is the confusion this is removing.
 */
import { prisma } from "@/lib/db";
import { unavailableWidgetIds } from "@/lib/dashboard/widget-modules";
import { isModuleEnabled } from "@/lib/modules/gate";

export async function resolveUnavailableWidgetIds(
  userId: string,
): Promise<string[]> {
  // The HRV probes are index-only existence checks
  // (`@@index([userId, type, measuredAt])`), not a summaries read; it runs
  // only when Recovery is off, so the common account pays nothing.
  // One flag, read the way this codebase reads one flag — not the whole
  // module map. `hrv` is the only conditionally-dead widget and `recovery`
  // is the only module that decides it.
  const recoveryEnabled = await isModuleEnabled(userId, "recovery");
  let hasSdnn = true;
  let hasRmssd = true;
  if (!recoveryEnabled) {
    const [sdnnRow, rmssdRow] = await Promise.all(
      (["HEART_RATE_VARIABILITY", "HRV_RMSSD"] as const).map((type) =>
        prisma.measurement.findFirst({
          where: { userId, type, deletedAt: null },
          select: { id: true },
        }),
      ),
    );
    hasSdnn = sdnnRow !== null;
    hasRmssd = rmssdRow !== null;
  }
  return unavailableWidgetIds(
    { recovery: recoveryEnabled },
    { hasSdnn, hasRmssd },
  );
}
