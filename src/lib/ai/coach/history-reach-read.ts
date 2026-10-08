/**
 * The person's Coach lookback limit, read from their saved preferences. Kept
 * apart from `history-reach.ts` so that module stays free of database access
 * and can be imported by client code (the settings picker).
 */
import { prisma } from "@/lib/db";
import { resolveModuleMap } from "@/lib/modules/gate";
import {
  parseCoachPrefs,
  type CoachExcludeMetric,
} from "@/lib/validations/coach-prefs";
import { reachFromPrefs, type CoachHistoryReach } from "./history-reach";
import { coachExclusions } from "./scope-gate";

export async function readCoachReach(
  userId: string,
): Promise<CoachHistoryReach> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { coachPrefsJson: true },
  });
  return reachFromPrefs(parseCoachPrefs(row?.coachPrefsJson));
}

/**
 * The person's Coach exclusions, as every Coach read applies them: their own
 * `excludeMetrics` plus the sources of each switched-off module. For a read
 * that does not go through the snapshot builder (`get_day`).
 */
export async function readCoachExclusions(
  userId: string,
): Promise<ReadonlySet<CoachExcludeMetric>> {
  const [row, moduleMap] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { coachPrefsJson: true },
    }),
    resolveModuleMap(userId),
  ]);
  return coachExclusions(parseCoachPrefs(row?.coachPrefsJson), moduleMap);
}
