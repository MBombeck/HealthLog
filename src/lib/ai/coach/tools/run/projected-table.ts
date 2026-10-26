import { DEFAULT_UNIT_PREFERENCES } from "@/lib/measurements/display-transform";
import { annotate } from "@/lib/logging/context";
import { resolveUserTimezone } from "@/lib/tz/resolver";
import type { CoachResultTable, CoachScopeWindow } from "@/lib/ai/coach/types";
import { readMetricTable } from "@/lib/ai/coach/results/metric-table-tool";
import {
  projectCompliance,
  projectLabs,
  projectWorkouts,
} from "@/lib/ai/coach/results/projections";
import { COACH_RESULT_TITLE_KEYS } from "@/lib/ai/coach/dialog-keys";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { DEFAULT_WINDOW } from "@/lib/ai/coach/snapshot-cache";
import {
  clampWindow,
  type CoachHistoryReach,
} from "@/lib/ai/coach/history-reach";
import type { CoachToolName } from "../definitions";
import type { CoachToolResult, CoachToolTurnContext } from "./types";

/**
 * The table an older tool's present result projects to, named with the
 * turn's next ref. A projection that fails leaves the answer as it was: the
 * table is a view of the result, never a condition for it.
 */
export async function withProjectedTable(
  name: CoachToolName,
  userId: string,
  rawArgs: unknown,
  fallbackWindow: CoachScopeWindow | undefined,
  result: CoachToolResult,
  turn: CoachToolTurnContext,
  reach: CoachHistoryReach,
): Promise<CoachToolResult> {
  const argWindow =
    rawArgs !== null &&
    typeof rawArgs === "object" &&
    typeof (rawArgs as { window?: unknown }).window === "string"
      ? ((rawArgs as { window: CoachScopeWindow }).window as CoachScopeWindow)
      : undefined;
  const window = clampWindow(
    argWindow ?? fallbackWindow ?? DEFAULT_WINDOW,
    reach,
  );
  try {
    let table: CoachResultTable | null = null;
    switch (name) {
      case "get_workouts":
        table = projectWorkouts(result.data, {
          ref: "r0",
          locale: turn.locale,
          window,
          timeZone: "UTC",
        });
        break;
      case "get_medication_compliance":
        table = projectCompliance(result.data, {
          ref: "r0",
          locale: turn.locale,
          window,
          timeZone: "UTC",
        });
        break;
      case "get_labs":
        table = projectLabs(result.data, {
          ref: "r0",
          locale: turn.locale,
          window,
          timeZone: await resolveUserTimezone(userId),
        });
        break;
      case "get_sleep": {
        const read = await readMetricTable({
          userId,
          metric: "sleep",
          window,
          period: "current",
          granularity: "day",
          timeZone: await resolveUserTimezone(userId),
          locale: turn.locale,
          ref: "r0",
          // Sleep is read in minutes for every reader; no preference applies.
          units: DEFAULT_UNIT_PREFERENCES,
          now: turn.now,
        });
        table =
          read && read.source.granularity === "day"
            ? {
                ...read,
                source: { ...read.source, tool: "get_sleep" },
                titleKey: COACH_RESULT_TITLE_KEYS.sleepByNight,
                title: getServerTranslator(turn.locale).t(
                  COACH_RESULT_TITLE_KEYS.sleepByNight,
                ),
              }
            : read && {
                ...read,
                source: { ...read.source, tool: "get_sleep" },
              };
        break;
      }
      default:
        return result;
    }
    if (!table) return result;
    const ref = turn.refs.next();
    if (!ref) return result;
    return { ...result, resultRef: ref, table: { ...table, ref } };
  } catch (err) {
    annotate({
      action: { name: "coach.result.projection_failed" },
      meta: {
        tool: name,
        reason: err instanceof Error ? err.name : "unknown",
      },
    });
    return result;
  }
}
