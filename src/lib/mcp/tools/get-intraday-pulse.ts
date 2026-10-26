import { z } from "zod/v4";

import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { loadIntradayPulse } from "@/lib/analytics/intraday-pulse-io";
import { DEFAULT_TIMEZONE, userDayKey } from "@/lib/tz/format";
import { READ_ONLY_ANNOTATIONS, type McpToolDefinition } from "./types";

/**
 * Output schema for `get_intraday_pulse` — the 10-minute "shape of the day"
 * plus, when every confidence gate holds, one cautious elevated-at-rest
 * ("tension") window. Verbatim re-export of `IntradayPulseResult`
 * (`intraday-pulse-io.ts`); `resolution` tells the caller whether `series` is
 * the dense 10-minute grain or the coarser hourly fallback.
 */
const getIntradayPulseOutput: z.ZodRawShape = {
  present: z.boolean(),
  reason: z.string().optional(),
  dateKey: z.string().optional(),
  timezone: z.string().optional(),
  bucketMinutes: z.number().optional(),
  resolution: z.enum(["tenMin", "hourly"]).optional(),
  series: z
    .array(
      z.object({
        startMinute: z.number(),
        mean: z.number(),
        count: z.number(),
        // The bucket's low / high where the source carries a
        // spread (`IntradayHrBucket`); returned since v1.30.7, never declared.
        min: z.number().optional(),
        max: z.number().optional(),
      }),
    )
    .optional(),
  baseline: z.number().nullable().optional(),
  baselineSource: z.enum(["resting", "proxy", "none"]).optional(),
  tension: z
    .object({
      startMinute: z.number(),
      endMinute: z.number(),
      partOfDay: z.enum(["morning", "afternoon", "evening", "night"]),
      meanHr: z.number(),
      baseline: z.number(),
      hrvConfirmed: z.boolean(),
    })
    .nullable()
    .optional(),
};

export const getIntradayPulseTool: McpToolDefinition = {
  name: "get_intraday_pulse",
  title: "Get the intraday pulse shape",
  description:
    "Fetch the user's own 10-minute heart-rate shape for ONE local day — 'what happened this afternoon?', 'was I tense during the meeting?'. When every confidence gate holds, also carries a single cautious elevated-at-rest ('tension') window: a DESCRIPTIVE pattern only, NEVER a stress diagnosis. Falls back to an hourly-grain shape for a day outside the dense-retention window — see the `resolution` field ('tenMin' vs 'hourly'); `tension` is only ever computed at the dense grain. Pulse is a core vital: no AI switch and no module gate apply. Returns { present: false } when the day has no pulse data.",
  inputShape: {
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe(
        "YYYY-MM-DD in the user's own timezone. Defaults to the user's local today.",
      ),
  },
  annotations: READ_ONLY_ANNOTATIONS,
  outputShape: getIntradayPulseOutput,
  async run(ctx, args) {
    // Mirrors `GET /api/insights/pulse/intraday`: a computation over core
    // vitals, served whatever the AI analysis opt-out says.
    const user = await prisma.user.findUnique({
      where: { id: ctx.userId },
      select: { timezone: true },
    });
    const timezone = user?.timezone || DEFAULT_TIMEZONE;
    const dateKey =
      typeof args.date === "string" && args.date
        ? args.date
        : userDayKey(new Date(), timezone);

    const result = await loadIntradayPulse(ctx.userId, timezone, dateKey);
    const present = result.series.length > 0;

    annotate({
      action: { name: "mcp.tool.invoked" },
      meta: { tool: "get_intraday_pulse", present },
    });
    return {
      present,
      ...(present ? {} : { reason: "no_data" }),
      dateKey: result.dateKey,
      timezone: result.timezone,
      bucketMinutes: result.bucketMinutes,
      resolution: result.resolution,
      series: result.series,
      baseline: result.baseline,
      baselineSource: result.baselineSource,
      tension: result.tension,
    };
  },
};
