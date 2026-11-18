import { z } from "zod/v4";

/**
 * The day's nutrient totals, one per catalog code, summed across sources the
 * way the nutrients page sums them.
 */
export const dayNutrientSchema = z
  .object({
    code: z
      .string()
      .describe("The nutrient catalog code (`protein`, `water`)."),
    amount: z
      .number()
      .nonnegative()
      .describe("The day's total in `unit`, unrounded."),
    unit: z
      .string()
      .describe(
        "The code's canonical unit as the nutrients routes spell it: `kcal`, `g`, `mg`, `ug`, `ml`, `IU`.",
      ),
  })
  .meta({ id: "DayNutrient" });
