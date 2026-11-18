import { z } from "zod/v4";

import { annotate } from "@/lib/logging/context";
import { getNutrients } from "@/lib/mcp/nutrients-read";
import { READ_ONLY_ANNOTATIONS, type McpToolDefinition } from "./types";

/**
 * Output schema for `get_nutrients` — either the presence overview (no
 * `nutrient` arg) or one nutrient's per-day series + reference. Every field
 * beyond `present` is optional so both shapes validate against one schema.
 */
const getNutrientsOutput: z.ZodRawShape = {
  present: z.boolean(),
  reason: z.string().optional(),
  windowDays: z.number().optional(),
  // Overview mode.
  nutrients: z
    .array(
      z.object({
        nutrient: z.string(),
        label: z.string(),
        unit: z.string(),
        latestDay: z.string(),
        latestAmount: z.number(),
        daysWithData: z.number(),
      }),
    )
    .optional(),
  // Per-nutrient mode.
  nutrient: z.string().optional(),
  label: z.string().optional(),
  unit: z.string().optional(),
  days: z.array(z.object({ day: z.string(), amount: z.number() })).optional(),
  reference: z
    .object({
      authority: z.enum(["EFSA", "IOM", "NIH ODS"]).optional(),
      kind: z.enum(["PRI", "AI", "safeLevel"]),
      direction: z.enum(["target", "upperGuidance"]),
      value: z.number(),
      source: z.string(),
    })
    .nullable()
    .optional(),
  personalTarget: z
    .object({
      value: z.number(),
      direction: z.enum(["target", "limit"]),
    })
    .nullable()
    .optional(),
};

export const getNutrientsTool: McpToolDefinition = {
  name: "get_nutrients",
  title: "Get nutrient intake",
  description:
    "Fetch the user's nutrient intake — water, caffeine, the tracked vitamins and minerals (sodium and potassium included), dietary energy in kcal, the macronutrients (protein, carbohydrates, fat and its saturated, monounsaturated and polyunsaturated parts, sugar, fiber) in g, cholesterol in mg, and alcohol in g of ethanol — as day totals across sources. Apple Health, Health Connect and a food-tracker bridge each report the whole day, so only the largest of them counts; a manual water entry and taken supplements add on top. Omit `nutrient` for a presence overview across every logged code (latest logged day, latest day's total, days with data). Pass a catalog code, or the nutrient's display name in any language HealthLog ships (e.g. 'water', 'magnesium', 'vitamin_d', 'Magnésium', 'Żelazo'), for that nutrient's per-day series over a trailing window, plus its dietary reference (with the authority that set it: EFSA, or IOM for protein and carbohydrates) resolved against the user's own profile sex — omitted, never guessed, when sex is not on file or the nutrient has none — and the target the user set for it, if any. Gated on the opt-in `nutrients` module. Returns { present: false, reason: \"module_disabled\" } when the module is off, or { present: false } when nothing matches.",
  inputShape: {
    nutrient: z
      .string()
      .min(1)
      .max(40)
      .optional()
      .describe(
        "A catalog code (e.g. 'water', 'caffeine', 'vitamin_d', 'magnesium') or its display name in any language HealthLog ships. Omit for a presence overview across all logged nutrients.",
      ),
    days: z
      .number()
      .int()
      .min(1)
      .max(365)
      .optional()
      .describe(
        "Trailing window in days. Overview mode (no `nutrient`) defaults to 14, capped at 365. Per-nutrient mode defaults to 30, capped at 90.",
      ),
  },
  annotations: READ_ONLY_ANNOTATIONS,
  outputShape: getNutrientsOutput,
  async run(ctx, args) {
    const result = await getNutrients(ctx.userId, {
      nutrient: typeof args.nutrient === "string" ? args.nutrient : undefined,
      days: typeof args.days === "number" ? args.days : undefined,
    });
    annotate({
      action: { name: "mcp.tool.invoked" },
      meta: { tool: "get_nutrients", present: result.present },
    });
    return result;
  },
};
