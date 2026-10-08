/**
 * `get_day` for the Coach and the MCP endpoint (v1.42, #613).
 *
 * The day the person sees, through the same loader, projected for a model:
 * life events and notes never leave (`model-projection.ts`), and a section of
 * a switched-off module is named as such rather than read. Life events are
 * not even loaded on this path: the sections the projection would drop are
 * taken out of the access set before the loader runs, so their rows are
 * neither read nor decrypted for a model's request.
 *
 * Read on the person's own record only: both callers act for the owner.
 */
import {
  MODEL_EXCLUDED_DAY_SECTIONS,
  type DaySectionKey,
} from "@/lib/day/contract";
import { loadDay } from "@/lib/day/load-day";
import { projectDayForModel, type ModelDay } from "@/lib/day/model-projection";
import { resolveDayAccess } from "@/lib/day/sections";
import {
  reachFloor,
  type CoachHistoryReach,
} from "@/lib/ai/coach/history-reach";
import { userDayKey } from "@/lib/tz/format";
import { localDayWindow } from "@/lib/tz/local-day";
import { resolveUserTimezone } from "@/lib/tz/resolver";

export type DayToolResult =
  | { present: true; data: ModelDay }
  | {
      present: false;
      reason: "no_data" | "outside_window" | "outside_reach";
    };

const EXCLUDED: ReadonlySet<DaySectionKey> = new Set<DaySectionKey>(
  MODEL_EXCLUDED_DAY_SECTIONS,
);

export async function readDayForTool(args: {
  userId: string;
  date: string;
  reach: CoachHistoryReach;
  now?: Date;
  /** Wraps a free-text leaf (a title) for the reader; identity by default. */
  text?: (value: string) => string;
}): Promise<DayToolResult> {
  const now = args.now ?? new Date();
  const tz = await resolveUserTimezone(args.userId);
  if (args.date > userDayKey(now, tz)) {
    return { present: false, reason: "outside_window" };
  }
  // A day that ended before the lookback limit is refused before anything
  // is read; a day inside it reads its comparisons no further back.
  const floor = reachFloor(args.reach, now);
  const { dayEnd } = localDayWindow(args.date, tz);
  if (floor !== null && dayEnd <= floor) {
    return { present: false, reason: "outside_reach" };
  }

  const access = await resolveDayAccess({
    recordId: args.userId,
    domainVisible: () => true,
    owner: true,
  });
  const readable = new Set(
    [...access.readable].filter((section) => !EXCLUDED.has(section)),
  );
  const day = await loadDay({
    recordId: args.userId,
    day: args.date,
    access: { ...access, readable },
    tz,
    floor,
  });
  const data = projectDayForModel(day, access.moduleOff, args.text);
  if (
    data.values.length === 0 &&
    data.events.length === 0 &&
    data.running.length === 0
  ) {
    return { present: false, reason: "no_data" };
  }
  return { present: true, data };
}
