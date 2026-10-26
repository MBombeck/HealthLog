import { z } from "zod/v4";

import { annotate } from "@/lib/logging/context";
import { buildCoachDataInventory } from "@/lib/ai/coach/tools/inventory";
import { metricStatusDiscoveryRows } from "@/lib/mcp/rich-reads";
import { READ_ONLY_ANNOTATIONS, type McpToolDefinition } from "./types";

/** Output schema for `list_metrics` — the inventory rows + flags. */
const listMetricsOutput: z.ZodRawShape = {
  present: z.boolean(),
  window: z.string().optional(),
  restMode: z.boolean().optional(),
  cycleEnabled: z.boolean().optional(),
  metrics: z
    .array(
      z.object({
        tool: z.string(),
        domain: z.string(),
        present: z.boolean(),
        count: z.number().optional(),
        metric: z.string().optional(),
        // #1170 — what the record holds for a domain the window found
        // nothing in (`InventoryEntry.availability`). The handler always
        // returned it; the advertised schema did not declare it, and the
        // output schema closes every object, so a strict client refused the
        // whole result.
        availability: z
          .object({
            state: z.string(),
            count: z.number().optional(),
            firstDate: z.string().optional(),
            lastDate: z.string().optional(),
            reachableWithWindow: z.string().nullable(),
          })
          .optional(),
      }),
    )
    .optional(),
};

export const listMetricsTool: McpToolDefinition = {
  name: "list_metrics",
  title: "List available metrics",
  description:
    "Enumerate which of the user's health data exists and how to fetch it: one row per domain with whether data is present, an approximate sample count, and the tool that retrieves it. Call this first to discover what is available before fetching figures.",
  inputShape: {},
  annotations: READ_ONLY_ANNOTATIONS,
  outputShape: listMetricsOutput,
  async run(ctx) {
    const [inventory, statusDiscoveryRows] = await Promise.all([
      buildCoachDataInventory(ctx.userId, undefined),
      // The metric-status-only set
      // (wrist temperature, cardio recovery, sleep score, breathing
      // disturbances, strain/load, …) is resolvable via `compare_metric` /
      // `get_metric_baseline` but sits off the Coach snapshot inventory, so
      // it never advertised itself here. Appended as supplement rows
      // rather than folded into `buildCoachDataInventory` (Coach-owned)
      // to keep the addition MCP-side, mirroring how the `search` probe
      // already surfaces the sibling v1.25 clinical-signal set.
      metricStatusDiscoveryRows(ctx.userId),
    ]);
    annotate({
      action: { name: "mcp.tool.invoked" },
      meta: { tool: "list_metrics", present: true },
    });
    return {
      present: true,
      window: inventory.window,
      restMode: inventory.restMode,
      cycleEnabled: inventory.cycleEnabled,
      metrics: [...inventory.entries, ...statusDiscoveryRows],
    };
  },
};
