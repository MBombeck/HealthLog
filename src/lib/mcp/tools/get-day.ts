import { z } from "zod/v4";

import { annotate } from "@/lib/logging/context";
import { getDayArgsSchema } from "@/lib/ai/coach/tools/definitions";
import { readDayForTool } from "@/lib/ai/coach/tools/day-read";
import { UNBOUNDED_REACH } from "@/lib/ai/coach/history-reach";
import {
  DAY_EVENT_KINDS,
  DAY_NOTABLE_KINDS,
  DAY_QUERY_PARAM,
  DAY_RUNNING_KINDS,
  DAY_SCORE_KEYS,
  DAY_SECTION_KEYS,
  DAY_TOOL_NAME,
  MODEL_EXCLUDED_DAY_SECTIONS,
  type DaySectionKey,
} from "@/lib/day/contract";
import { fenceUserText } from "@/lib/ai/coach/data-fence";
import { resolveBaseOrigin } from "@/lib/mcp/oauth/config";
import { READ_ONLY_ANNOTATIONS, type McpToolDefinition } from "./types";

/**
 * `get_day` (#613). Declared field by field, so the advertised schema
 * itself says what a day can carry for a model: no note, no document name,
 * and no life-event section anywhere (the section enum below leaves it out,
 * and a strict client refuses a result that grew one). Titles are the
 * person's own words and come fenced.
 */
const MODEL_DAY_SECTIONS = DAY_SECTION_KEYS.filter(
  (key) => !(MODEL_EXCLUDED_DAY_SECTIONS as readonly string[]).includes(key),
) as [DaySectionKey, ...DaySectionKey[]];
const modelDaySection = z.enum(MODEL_DAY_SECTIONS);
const getDayOutput: z.ZodRawShape = {
  present: z.boolean(),
  reason: z.string().optional(),
  url: z.string().optional(),
  data: z
    .object({
      date: z.string(),
      counts: z.object({ values: z.number(), entries: z.number() }),
      running: z.array(
        z.object({
          kind: z.enum(DAY_RUNNING_KINDS),
          section: modelDaySection,
          title: z.string(),
          sub: z.string().nullable(),
          since: z.string().nullable(),
          until: z.string().nullable(),
          dayIndex: z.number().nullable(),
          dayCount: z.number().nullable(),
        }),
      ),
      values: z.array(
        z.object({
          type: z.string(),
          value: z.number(),
          unit: z.string(),
          at: z.string(),
          band: z
            .object({ lo: z.number(), hi: z.number(), n: z.number() })
            .nullable(),
        }),
      ),
      events: z.array(
        z.object({
          at: z.string().nullable(),
          kind: z.enum(DAY_EVENT_KINDS),
          section: modelDaySection,
          title: z.string(),
          meta: z.string().nullable(),
        }),
      ),
      notable: z.array(
        z.object({
          kind: z.enum(DAY_NOTABLE_KINDS),
          type: z.string().nullable(),
          params: z.record(z.string(), z.union([z.string(), z.number()])),
        }),
      ),
      scores: z.array(
        z.object({
          score: z.enum(DAY_SCORE_KEYS),
          value: z.number(),
          max: z.number(),
          band: z
            .object({ lo: z.number(), hi: z.number(), n: z.number() })
            .nullable(),
        }),
      ),
      // The movement context (Dawarich), without a travel country.
      movement: z
        .object({
          distance: z.object({
            unit: z.enum(["km", "mi"]),
            total: z.number().nullable(),
            driving: z.number().nullable(),
            train: z.number().nullable(),
          }),
          placesVisited: z.number().nullable(),
          awayFromHomeMinutes: z.number().nullable(),
          travel: z.object({ isTravelDay: z.boolean() }).nullable(),
        })
        .nullable()
        .optional(),
      unavailable: z.array(
        z.object({
          section: modelDaySection,
          reason: z.enum(["module_disabled", "not_shared"]),
        }),
      ),
    })
    .optional(),
};

export const getDayTool: McpToolDefinition = {
  name: DAY_TOOL_NAME,
  title: "Get one day",
  description:
    "Fetch one local calendar day of the user's record (YYYY-MM-DD, in the user's own time zone): what ran through it (medications and courses with dose and day n, pauses, an illness with its day n, a cycle phase with its cycle day, a trip; day n counts from the record's own start date and is null, with `since` null, when the record holds none), the readings in that day's window with the user's usual range over the 30 days before (null with too little history), what happened on it (intakes, dose changes, symptoms, lab results, visits, vaccinations, check-ups, documents by kind, mood and screener scores, workouts), the day's scores (healthScore, readiness, recovery from a device, sleepScore, strain; each a number on its own 0 to `max` scale with the usual range beside it, absent when not recorded that day), and deterministic notable observations (highest or lowest for at least three months, first reading of a kind). Notes, document names, visit reasons, practitioner names and life events are never included. `unavailable` names sections whose module is off (module_disabled). Each result carries `url`, the day in the app. Returns { present: false } with no_data, outside_window (a future date) or invalid_arguments.",
  inputShape: {
    date: z.string().describe("The local calendar date, YYYY-MM-DD."),
  },
  annotations: READ_ONLY_ANNOTATIONS,
  outputShape: getDayOutput,
  async run(ctx, args) {
    const parsed = getDayArgsSchema.safeParse(args ?? {});
    if (!parsed.success) {
      return { present: false, reason: "invalid_arguments" };
    }
    const result = await readDayForTool({
      userId: ctx.userId,
      date: parsed.data.date,
      reach: UNBOUNDED_REACH,
      text: fenceUserText,
    });
    annotate({
      action: { name: "mcp.tool.invoked" },
      meta: { tool: DAY_TOOL_NAME, present: result.present },
    });
    if (!result.present) return result;
    return {
      present: true,
      url: `${resolveBaseOrigin()}/?${DAY_QUERY_PARAM}=${parsed.data.date}`,
      data: result.data,
    };
  },
};
