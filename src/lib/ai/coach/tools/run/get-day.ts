import { readCoachExclusions } from "@/lib/ai/coach/history-reach-read";
import { fenceUserText } from "@/lib/ai/coach/data-fence";
import type { CoachHistoryReach } from "@/lib/ai/coach/history-reach";
import { getDayArgsSchema } from "../definitions";
import { readDayForTool } from "../day-read";
import { badArgs } from "./shared";
import type { CoachToolResult } from "./types";

/**
 * #613: one local day across the record, projected for a model:
 * never the person's life events or notes. A day older than the lookback
 * limit is refused before anything is read.
 */
export async function getDay(
  userId: string,
  rawArgs: unknown,
  reach: CoachHistoryReach,
): Promise<CoachToolResult> {
  const parsed = getDayArgsSchema.safeParse(rawArgs);
  if (!parsed.success) return badArgs("get_day", parsed.error);
  const result = await readDayForTool({
    userId,
    date: parsed.data.date,
    reach,
    // The person's Coach exclusions hold here as in every other read.
    loadExcluded: () => readCoachExclusions(userId),
    text: fenceUserText,
  });
  if (result.present) return { present: true, data: result.data };
  return { present: false, reason: result.reason };
}
