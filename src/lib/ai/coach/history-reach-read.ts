/**
 * The person's Coach lookback limit, read from their saved preferences. Kept
 * apart from `history-reach.ts` so that module stays free of database access
 * and can be imported by client code (the settings picker).
 */
import { prisma } from "@/lib/db";
import { parseCoachPrefs } from "@/lib/validations/coach-prefs";
import { reachFromPrefs, type CoachHistoryReach } from "./history-reach";

export async function readCoachReach(
  userId: string,
): Promise<CoachHistoryReach> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { coachPrefsJson: true },
  });
  return reachFromPrefs(parseCoachPrefs(row?.coachPrefsJson));
}
