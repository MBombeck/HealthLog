import { resolveUserTimezone } from "@/lib/tz/resolver";
import { buildCoachSnapshot } from "@/lib/ai/coach/snapshot";
import type {
  CoachResultTable,
  CoachScope,
  CoachScopeWindow,
} from "@/lib/ai/coach/types";
import {
  METRIC_TABLE_EXCLUDED_SOURCES,
  compareWithCurrent,
  readMetricTable,
  summariseTable,
} from "@/lib/ai/coach/results/metric-table-tool";
import { DEFAULT_WINDOW } from "@/lib/ai/coach/snapshot-cache";
import {
  clampWindow,
  type CoachHistoryReach,
} from "@/lib/ai/coach/history-reach";
import { getMetricTableArgsSchema } from "../definitions";
import { OUTSIDE_REACH_REASON, subjectForTool } from "../availability";
import { scopeAdmits, tableRangeWithinReach } from "./prior-results";
import { badArgs, emptyRead, limitWindow } from "./shared";
import type { CoachToolResult, CoachToolTurnContext } from "./types";

export async function getMetricTable(
  userId: string,
  rawArgs: unknown,
  fallbackWindow: CoachScopeWindow | undefined,
  sharedScope: CoachScope | undefined,
  turn: CoachToolTurnContext | undefined,
  reach: CoachHistoryReach,
): Promise<CoachToolResult> {
  const parsed = getMetricTableArgsSchema.safeParse(rawArgs);
  if (!parsed.success) return badArgs("get_metric_table", parsed.error);
  const { metric, granularity } = parsed.data;
  // All time becomes the lookback limit; a narrower window stays.
  const window = clampWindow(
    parsed.data.window ?? fallbackWindow ?? DEFAULT_WINDOW,
    reach,
  );
  const period =
    window === "allTime" ? "current" : (parsed.data.period ?? "current");

  const excluded = METRIC_TABLE_EXCLUDED_SOURCES[metric];
  if (excluded) return { present: false, reason: excluded };

  // An earlier period is read only when all of it lies inside the limit: the
  // previous window or the same window a year ago, cut short, would be a
  // different comparison under the same name.
  if (
    period !== "current" &&
    !tableRangeWithinReach(window, period, reach, turn?.now)
  ) {
    return {
      present: false,
      reason: OUTSIDE_REACH_REASON,
      searchedWindow: window,
    };
  }

  // Same gate as every other read: a module switched off, or a metric the
  // person excluded from the Coach, is not read here either.
  const gate = await buildCoachSnapshot(
    userId,
    sharedScope ?? {
      sources: [metric],
      window: limitWindow(fallbackWindow, reach),
    },
    { reach },
  );
  if (!scopeAdmits(gate.sections, metric)) {
    return {
      present: false,
      reason: "unavailable_in_scope",
      searchedWindow: window,
    };
  }

  const timeZone = await resolveUserTimezone(userId);
  const table = await readMetricTable({
    userId,
    metric,
    window,
    period,
    granularity,
    timeZone,
    locale: turn?.locale ?? "en",
    ref: "r0",
    units: gate.units,
    now: turn?.now,
  });
  if (!table) {
    return emptyRead(
      userId,
      metric,
      subjectForTool("get_metric_table", metric),
      window,
      reach,
    );
  }
  // An earlier window is read to be compared: read the current one too and
  // hand the model both, and the change between them, in one summary.
  let comparison: Record<string, unknown> | null = null;
  if (period !== "current") {
    const current = await readMetricTable({
      userId,
      metric,
      window,
      period: "current",
      granularity,
      timeZone,
      locale: turn?.locale ?? "en",
      ref: "r0",
      units: gate.units,
      now: turn?.now,
    });
    comparison = current ? compareWithCurrent(table, current) : null;
  }
  const summarise = (t: CoachResultTable) => ({
    ...summariseTable(t),
    ...(comparison ? { comparison } : {}),
  });
  const ref = turn?.refs.next() ?? null;
  if (!ref) {
    // Outside a chat turn, or past the eighth table: the model still gets
    // the figures, there is just no table to name.
    return { present: true, data: summarise(table) };
  }
  const named = { ...table, ref };
  return {
    present: true,
    resultRef: ref,
    data: summarise(named),
    table: named,
  };
}
