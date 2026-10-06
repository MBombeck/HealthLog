/**
 * v1.41 — `compare_series`: two series of the record on one chart.
 *
 * Two kinds of comparison, each one call instead of two reads the model
 * would have to line up itself:
 *
 *   - `periods`: one metric over the current window and an earlier one (the
 *     period before, or the same window a year earlier), overlaid;
 *   - `metrics`: two metrics over the same window side by side, on two axes
 *     when their units differ.
 *
 * Both sides are read through the metric table tool itself
 * (`get_metric_table` in the executor), so every gate holds exactly as for
 * a single table: the modules, the metrics the person excluded from the
 * Coach, the lookback limit, the reasons a read comes back empty. The two
 * tables are read under a private name allocator and joined into one table
 * that takes the turn's next name; the model gets both summaries, and for
 * `periods` the change the server computed between them.
 *
 * Kept out of the executor and its tool catalogue on purpose: the MCP
 * surface runs the executor and is not part of this release.
 */
import { z } from "zod/v4";

import type { AiToolDef } from "@/lib/ai/types";
import {
  coachScopeSourceSchema,
  coachScopeWindowSchema,
  type CoachScope,
  type CoachScopeWindow,
} from "@/lib/ai/coach/types";
import type { CoachHistoryReach } from "@/lib/ai/coach/history-reach";
import { annotate } from "@/lib/logging/context";
import { createResultRefAllocator } from "@/lib/ai/coach/results/refs";
import { projectCompare } from "@/lib/ai/coach/results/projections";

import { coachResultGranularitySchema } from "./definitions";
import {
  executeCoachTool,
  type CoachToolResult,
  type CoachToolTurnContext,
} from "./executor";

export const COMPARE_SERIES_TOOL_NAME = "compare_series";

export const compareSeriesArgsSchema = z
  .object({
    mode: z.enum(["periods", "metrics"]),
    metric: coachScopeSourceSchema,
    metricB: coachScopeSourceSchema.optional(),
    window: coachScopeWindowSchema.optional(),
    granularity: coachResultGranularitySchema.optional(),
    basis: z.enum(["previous", "yearAgo"]).optional(),
  })
  .strict();

export const COMPARE_SERIES_TOOL_DEF: AiToolDef = {
  name: COMPARE_SERIES_TOOL_NAME,
  description:
    "Compare two series on one chart. mode=periods: ONE metric over the current window against the period before (basis=previous, default) or the same window a year earlier (basis=yearAgo), overlaid; it also returns the change the server computed. mode=metrics: TWO metrics (metric and metricB) over the same window side by side, for 'does my sleep go with my resting pulse?' questions; a pattern between two metrics is an association, never a cause. Use it for every comparison question instead of two separate reads. Returns both summaries and the table's name (resultRef); the person sees the comparison chart under your answer.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["mode", "metric"],
    properties: {
      mode: { type: "string", enum: ["periods", "metrics"] },
      metric: {
        type: "string",
        enum: coachScopeSourceSchema.options,
        description: "The metric, or the first of two.",
      },
      metricB: {
        type: "string",
        enum: coachScopeSourceSchema.options,
        description: "mode=metrics only: the second metric.",
      },
      window: {
        type: "string",
        enum: coachScopeWindowSchema.options,
        description:
          "Analysis window, cut to the user's lookback limit like every window. allTime cannot be compared with an earlier period.",
      },
      granularity: {
        type: "string",
        enum: coachResultGranularitySchema.options,
        description: "One row per day, week or month; defaults by window.",
      },
      basis: {
        type: "string",
        enum: ["previous", "yearAgo"],
        description:
          "mode=periods only: what the current window is compared with.",
      },
    },
  },
};

function tableArgs(args: {
  metric: string;
  window: CoachScopeWindow | undefined;
  granularity: string | undefined;
  period: "current" | "previous" | "yearAgo";
}): string {
  return JSON.stringify({
    metric: args.metric,
    ...(args.window ? { window: args.window } : {}),
    ...(args.granularity ? { granularity: args.granularity } : {}),
    period: args.period,
  });
}

/**
 * Run one `compare_series` call. Never throws; a call that does not validate
 * is `invalid_arguments`, a side that holds nothing reports that side's own
 * reason, and a comparison with too few shared points still gives the model
 * both summaries, with no chart.
 */
export async function runCompareSeries(args: {
  userId: string;
  rawArguments: string;
  fallbackWindow?: CoachScopeWindow;
  sharedScope?: CoachScope;
  reach: CoachHistoryReach;
  turn?: CoachToolTurnContext;
}): Promise<CoachToolResult> {
  let raw: unknown;
  try {
    raw = args.rawArguments.trim() === "" ? {} : JSON.parse(args.rawArguments);
  } catch {
    return { present: false, reason: "invalid_arguments" };
  }
  const parsed = compareSeriesArgsSchema.safeParse(raw);
  if (!parsed.success) return { present: false, reason: "invalid_arguments" };
  const call = parsed.data;
  if (
    call.mode === "metrics" &&
    (!call.metricB || call.metricB === call.metric)
  ) {
    return { present: false, reason: "invalid_arguments" };
  }
  if (call.mode === "periods" && call.window === "allTime") {
    return { present: false, reason: "invalid_arguments" };
  }

  // Both sides are read as tables under a name allocator of their own: the
  // turn names only the joined table.
  const sideTurn: CoachToolTurnContext | undefined = args.turn
    ? { ...args.turn, refs: createResultRefAllocator() }
    : undefined;
  const read = (metric: string, period: "current" | "previous" | "yearAgo") =>
    executeCoachTool({
      userId: args.userId,
      name: "get_metric_table",
      rawArguments: tableArgs({
        metric,
        window: call.window,
        granularity: call.granularity,
        period,
      }),
      fallbackWindow: args.fallbackWindow,
      sharedScope: args.sharedScope,
      reach: args.reach,
      ...(sideTurn ? { turn: sideTurn } : {}),
    });

  const basis = call.basis ?? "previous";
  const [first, second] =
    call.mode === "periods"
      ? await Promise.all([
          read(call.metric, "current"),
          read(call.metric, basis),
        ])
      : await Promise.all([
          read(call.metric, "current"),
          read(call.metricB as string, "current"),
        ]);

  if (!first.present) return first;
  const data: Record<string, unknown> = {
    mode: call.mode,
    ...(call.mode === "periods" ? { basis } : {}),
    a: first.data,
    b: second.present
      ? second.data
      : { present: false, reason: second.reason ?? "no_data" },
  };
  const joined =
    second.present && first.table && second.table && args.turn
      ? projectCompare({
          mode: call.mode,
          a: first.table,
          b: second.table,
          ...(call.mode === "periods" ? { basis } : {}),
          ref: "r0",
          locale: args.turn.locale,
        })
      : null;
  if (!joined || !args.turn) {
    annotate({
      action: { name: "coach.compare.no_chart" },
      meta: { mode: call.mode, bothSides: second.present },
    });
    return { present: true, data };
  }
  const ref = args.turn.refs.next();
  if (!ref) return { present: true, data };
  annotate({
    action: { name: "coach.compare.built" },
    meta: {
      mode: call.mode,
      rows: joined.rows.length,
      axes: joined.chart?.kind === "compare" ? joined.chart.axes : 1,
    },
  });
  return {
    present: true,
    resultRef: ref,
    data: { ...data, resultRef: ref },
    table: { ...joined, ref },
  };
}
