import type { CoachScopeWindow } from "@/lib/ai/coach/types";
import type { CoachHistoryReach } from "@/lib/ai/coach/history-reach";
import { getEnvironmentArgsSchema } from "../definitions";
import { readEnvironmentForTool } from "../environment-read";
import { badArgs } from "./shared";
import type { CoachToolResult } from "./types";

/**
 * #615: the stored days' weather and air quality, without any
 * location. Module-gated inside the reader (off answers `module_disabled`
 * without reading a row) and clamped to the lookback limit.
 */
export async function getEnvironment(
  userId: string,
  rawArgs: unknown,
  fallbackWindow: CoachScopeWindow | undefined,
  reach: CoachHistoryReach,
): Promise<CoachToolResult> {
  const parsed = getEnvironmentArgsSchema.safeParse(rawArgs);
  if (!parsed.success) return badArgs("get_environment", parsed.error);
  const result = await readEnvironmentForTool({
    userId,
    window: parsed.data.window ?? fallbackWindow ?? "last30days",
    reach,
  });
  if (result.present) return { present: true, data: result.data };
  return {
    present: false,
    reason: result.reason,
    ...(result.searchedWindow ? { searchedWindow: result.searchedWindow } : {}),
    ...(result.available ? { available: result.available } : {}),
  };
}
