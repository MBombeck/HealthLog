import { z } from "zod/v4";

import { annotate } from "@/lib/logging/context";
import { executeCoachTool } from "@/lib/ai/coach/tools/executor";
import { coachScopeWindowSchema } from "@/lib/ai/coach/types";
import { encodeOffsetCursor, decodeOffsetCursor } from "@/lib/mcp/pagination";
import { READ_ONLY_ANNOTATIONS, type McpToolDefinition } from "./types";

/** Cap on metrics fetched in one `get_metrics` call (paginated past the cap). */
const MAX_METRICS_PER_CALL = 24;
/** Metrics resolved per `get_metrics` page. */
const METRICS_PAGE_SIZE = 8;

/** Output schema for `get_metrics` — the multi-metric fan-out + pagination. */
const getMetricsOutput: z.ZodRawShape = {
  present: z.boolean(),
  window: z.string().optional(),
  results: z
    .array(
      z.object({
        metric: z.string(),
        present: z.boolean(),
        reason: z.string().optional(),
        data: z.unknown().optional(),
        grounding: z.string().optional(),
      }),
    )
    .optional(),
  nextCursor: z.string().optional(),
};

export const getMetricsTool: McpToolDefinition = {
  name: "get_metrics",
  title: "Get several metric series at once",
  description:
    "Fetch the time series for SEVERAL metrics in one call — a fan-out over the same single-metric read `get_metric_series` runs, returning one grounded result per metric (each with { present } and the metric's aggregate/timelines when present). Paginated: when more metrics remain than fit one page, pass the opaque nextCursor back as `cursor`. Use for a multi-metric question instead of many separate calls.",
  inputShape: {
    metrics: z
      .array(z.string().min(1).max(60))
      .min(1)
      .max(MAX_METRICS_PER_CALL)
      .describe(
        "The metrics to fetch (e.g. ['weight','pulse','hrv']). Unknown metrics return { present: false } for that entry, never an error.",
      ),
    window: coachScopeWindowSchema.optional(),
    cursor: z
      .string()
      .max(256)
      .optional()
      .describe(
        "Opaque pagination cursor from a previous response's nextCursor. Treat as a black box.",
      ),
  },
  annotations: READ_ONLY_ANNOTATIONS,
  outputShape: getMetricsOutput,
  async run(ctx, args) {
    const requested = Array.isArray(args.metrics)
      ? args.metrics
          .filter((m): m is string => typeof m === "string")
          .map((m) => m.trim())
          .filter((m) => m.length > 0)
          .slice(0, MAX_METRICS_PER_CALL)
      : [];
    const window = typeof args.window === "string" ? args.window : undefined;

    const offset = decodeOffsetCursor(args.cursor);
    const page = requested.slice(offset, offset + METRICS_PAGE_SIZE);
    const hasMore = offset + METRICS_PAGE_SIZE < requested.length;

    // Fan out over the SAME single-metric read; the executor validates each
    // metric and returns a grounded `{ present, … }` (never throws), so one
    // unknown metric cannot break the batch.
    const results = await Promise.all(
      page.map(async (metric) => {
        const r = (await executeCoachTool({
          userId: ctx.userId,
          sourceSnapshot: true,
          name: "get_metric_series",
          rawArguments: JSON.stringify({
            metric,
            ...(window ? { window } : {}),
          }),
        })) as {
          present: boolean;
          reason?: string;
          data?: unknown;
          grounding?: string;
        };
        return {
          metric,
          present: r.present,
          ...(r.reason ? { reason: r.reason } : {}),
          ...(r.data !== undefined ? { data: r.data } : {}),
          ...(r.grounding ? { grounding: r.grounding } : {}),
        };
      }),
    );

    annotate({
      action: { name: "mcp.tool.invoked" },
      meta: {
        tool: "get_metrics",
        present: results.some((r) => r.present),
      },
    });
    return {
      present: results.some((r) => r.present),
      ...(window ? { window } : {}),
      results,
      ...(hasMore
        ? { nextCursor: encodeOffsetCursor(offset + METRICS_PAGE_SIZE) }
        : {}),
    };
  },
};
