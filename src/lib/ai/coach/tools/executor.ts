/**
 * v1.20.0 — Coach retrieval tool executor.
 *
 * Dispatches a single tool call from the model: validates the raw JSON
 * arguments against the tool's Zod schema, runs the existing
 * server-authoritative snapshot builder scoped to just the requested domain,
 * and slices the matching section(s) out of the structured result.
 *
 * GROUNDING CONTRACTS (the hallucination audit hammers these):
 *   - Every tool returns a structured `{ present: boolean }`. When the domain
 *     carries no data — or the user opted out of the owning module — the result
 *     is `{ present: false, reason }`. It NEVER throws and NEVER returns an
 *     ambiguous `[]`, so the model can always tell "no data" from "data".
 *   - An empty WINDOW read is never reported as absence on its own. Every
 *     `present: false` that comes from a missing snapshot section routes through
 *     `resolveEmptyRead`, which probes whether the record holds rows outside the
 *     window and returns `outside_window` (with the range + a bounded aggregate)
 *     rather than `no_data`. One reason code for "never recorded" and "recorded,
 *     outside the window I searched" is what made the Coach deny data the app
 *     was displaying on the next screen.
 *   - Module / cycle gates are enforced AT THE BUILDER (`buildCoachSnapshot`
 *     applies `MODULE_EXCLUDED_SOURCES` + the cycle gate before any row is
 *     read), so an opted-out domain is structurally unfetchable here — the
 *     section simply never appears and the executor reports `present: false`.
 *   - `userId` is the session-narrowed id passed by the route, never a tool
 *     argument. Tools are read-only (snapshot reads only), so there is no
 *     mutation or egress surface.
 *
 * The builder result is memoised by the 60s snapshot LRU keyed on
 * `(userId, window, sources)`.
 *
 * v1.21.0 — ONE snapshot per turn. The route hands every tool the SAME
 * `sharedScope` it built the DATA INVENTORY against (the full source set + the
 * conversation window). A full-source build already contains every section, so
 * each tool reads under that shared scope key and slices its own section out —
 * landing the 60s LRU hit the inventory primed rather than rebuilding a
 * distinct single-source snapshot per tool (the D5-1 N-builds-per-turn cost).
 * A tool that overrides the window to something OTHER than the shared window
 * still gets a correct, distinct build (the rare case); the common path
 * collapses to one build.
 *
 * This module is the entry point and the dispatch table. Each tool's
 * executor lives in `run/<tool>.ts`, the result shapes in `run/types.ts`,
 * and the snapshot plumbing they share in `run/shared.ts`.
 */
import { annotate } from "@/lib/logging/context";
import type { CoachScope, CoachScopeWindow } from "@/lib/ai/coach/types";
import {
  isCoachToolName,
  SHOW_RESULT_TOOL_NAME,
  type CoachToolName,
} from "./definitions";
import {
  UNBOUNDED_REACH,
  type CoachHistoryReach,
} from "@/lib/ai/coach/history-reach";
import type { CoachToolResult, CoachToolTurnContext } from "./run/types";
import { getMetricSeries } from "./run/get-metric-series";
import { getGlucosePanel } from "./run/get-glucose-panel";
import { getSleep } from "./run/get-sleep";
import { getMedicationCompliance } from "./run/get-medication-compliance";
import { getLabs } from "./run/get-labs";
import { getIllnessRecovery } from "./run/get-illness-recovery";
import { getWorkouts } from "./run/get-workouts";
import { getCycle } from "./run/get-cycle";
import { getCorrelations } from "./run/get-correlations";
import { getMetricTable } from "./run/get-metric-table";
import { getEnvironment } from "./run/get-environment";
import { getDay } from "./run/get-day";
import { showResult } from "./run/show-result";
import { withProjectedTable } from "./run/projected-table";

/**
 * Execute one tool call. `rawArguments` is the model's raw JSON-string
 * arguments (parsed + validated here, never trusted blindly). Returns a
 * grounded `CoachToolResult` — a validation failure or unknown tool resolves
 * to `{ present: false }`, never a throw, so a single bad call can't break the
 * turn.
 */
export async function executeCoachTool(args: {
  userId: string;
  name: string;
  rawArguments: string;
  /** The conversation's effective window, used when a call omits `window`. */
  fallbackWindow?: CoachScopeWindow;
  /**
   * v1.21.0 — the turn's shared full-source snapshot scope (the same one
   * the DATA INVENTORY was built against). When present and the tool's window
   * matches, the tool reads under this scope key so it lands the inventory's
   * already-built cache entry instead of rebuilding a single-source snapshot.
   */
  sharedScope?: CoachScope;
  /**
   * Build a single-metric read from that source's own rows
   * (`source-snapshot.ts`) rather than from a Coach snapshot. Set by the MCP
   * surface, whose reads have no turn snapshot to land on and keep only the
   * one section; the section is the same either way.
   */
  sourceSnapshot?: boolean;
  /** v1.39.4 — the chat turn, when the call runs inside one. */
  turn?: CoachToolTurnContext;
  /**
   * How far back the call may read: the person's Coach lookback limit. Every
   * read below is clamped to it. Absent is no limit, which is what an MCP
   * client gets: it reads with its own window arguments, and the Coach
   * setting governs the Coach.
   */
  reach?: CoachHistoryReach;
}): Promise<CoachToolResult> {
  const {
    userId,
    name,
    rawArguments,
    fallbackWindow,
    sharedScope,
    sourceSnapshot = false,
    turn,
  } = args;
  const reach = args.reach ?? UNBOUNDED_REACH;

  if (!isCoachToolName(name) && name !== SHOW_RESULT_TOOL_NAME) {
    annotate({
      action: { name: "coach.tool.unknown" },
      meta: { tool: name.slice(0, 48) },
    });
    return { present: false, reason: "unknown_tool" };
  }

  let parsedArgs: unknown;
  try {
    parsedArgs = rawArguments.trim() === "" ? {} : JSON.parse(rawArguments);
  } catch {
    annotate({
      action: { name: "coach.tool.bad_arguments" },
      meta: { tool: name, reason: "invalid_json" },
    });
    return { present: false, reason: "invalid_arguments" };
  }

  try {
    const result =
      name === SHOW_RESULT_TOOL_NAME
        ? await showResult(userId, parsedArgs, sharedScope, turn, reach)
        : await dispatch(
            name as CoachToolName,
            userId,
            parsedArgs,
            fallbackWindow,
            sharedScope,
            turn,
            reach,
            sourceSnapshot,
          );
    annotate({
      action: { name: "coach.tool.executed" },
      meta: { tool: name, present: result.present },
    });
    return result;
  } catch (err) {
    // A read failure must degrade to a grounded "no data" rather than break
    // the loop — the model then says it could not retrieve the metric.
    annotate({
      action: { name: "coach.tool.error" },
      meta: {
        tool: name,
        reason: err instanceof Error ? err.name : "unknown",
      },
    });
    return { present: false, reason: "retrieval_failed" };
  }
}

async function dispatch(
  name: CoachToolName,
  userId: string,
  rawArgs: unknown,
  fallbackWindow: CoachScopeWindow | undefined,
  sharedScope: CoachScope | undefined,
  turn: CoachToolTurnContext | undefined,
  reach: CoachHistoryReach,
  sourceSnapshot: boolean,
): Promise<CoachToolResult> {
  const result = await dispatchRead(
    name,
    userId,
    rawArgs,
    fallbackWindow,
    sharedScope,
    turn,
    reach,
    sourceSnapshot,
  );
  if (!turn || !result.present || result.table) return result;
  return withProjectedTable(
    name,
    userId,
    rawArgs,
    fallbackWindow,
    result,
    turn,
    reach,
  );
}

async function dispatchRead(
  name: CoachToolName,
  userId: string,
  rawArgs: unknown,
  fallbackWindow: CoachScopeWindow | undefined,
  sharedScope: CoachScope | undefined,
  turn: CoachToolTurnContext | undefined,
  reach: CoachHistoryReach,
  sourceSnapshot: boolean,
): Promise<CoachToolResult> {
  // Every branch takes the lookback limit; `coach-history-reach-guard.test.ts`
  // fails when one does not.
  switch (name) {
    case "get_metric_series":
      return getMetricSeries(
        userId,
        rawArgs,
        fallbackWindow,
        sharedScope,
        reach,
        sourceSnapshot,
      );
    case "get_glucose_panel":
      return getGlucosePanel(
        userId,
        rawArgs,
        fallbackWindow,
        sharedScope,
        reach,
      );
    case "get_sleep":
      return getSleep(userId, rawArgs, fallbackWindow, sharedScope, reach);
    case "get_medication_compliance":
      return getMedicationCompliance(
        userId,
        rawArgs,
        fallbackWindow,
        sharedScope,
        reach,
      );
    case "get_labs":
      return getLabs(userId, rawArgs, fallbackWindow, sharedScope, reach);
    case "get_illness_recovery":
      return getIllnessRecovery(userId, fallbackWindow, sharedScope, reach);
    case "get_workouts":
      return getWorkouts(userId, rawArgs, fallbackWindow, sharedScope, reach);
    case "get_cycle":
      return getCycle(userId, rawArgs, sharedScope, reach);
    case "get_correlations":
      return getCorrelations(userId, rawArgs, reach);
    case "get_metric_table":
      return getMetricTable(
        userId,
        rawArgs,
        fallbackWindow,
        sharedScope,
        turn,
        reach,
      );
    case "get_environment":
      return getEnvironment(userId, rawArgs, fallbackWindow, reach);
    case "get_day":
      return getDay(userId, rawArgs, reach);
  }
}
