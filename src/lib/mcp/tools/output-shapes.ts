import { z } from "zod/v4";

import { isoDateTime } from "@/lib/validations/datetime";

// ── Output schemas ───────────────────────────────────────────────────
// Every field except the presence anchor (`present`) is optional so a grounded
// `{ present: false }` miss and a full hit both conform — the SDK validates the
// returned `structuredContent` against these (ChatGPT Apps-SDK conformance).

export const bandShape = z
  .object({ low: z.number(), high: z.number() })
  .nullable()
  .optional();

/**
 * The shared output shape for the Coach-F1-backed reads (`get_metric_series`,
 * `get_glucose_panel`, `get_sleep`, `get_workouts`, `get_illness_recovery`,
 * `get_cycle`, `get_medication_compliance`, `get_correlations`). The executor
 * returns the grounded `{ present, reason?, data?, grounding? }` contract; `data`
 * is the server-authoritative domain section (its inner shape is the snapshot's,
 * carried opaque here) so both a miss and a full hit validate.
 */
export const coachReadOutput: z.ZodRawShape = {
  present: z.boolean(),
  reason: z.string().optional(),
  data: z.unknown().optional(),
  grounding: z.string().optional(),
  // A miss describes its own scope and, when the record holds rows
  // the window could not reach, what it holds (`CoachToolResult`). The
  // executor has returned both since v1.37; undeclared, they made a strict
  // client refuse every out-of-window read (the #1170 class).
  searchedWindow: z.string().optional(),
  available: z
    .object({
      count: z.number(),
      firstDate: z.string(),
      lastDate: z.string(),
      series: z
        .array(
          z.object({
            series: z.string(),
            unit: z.string().nullable(),
            count: z.number(),
            mean: z.number(),
            min: z.number(),
            max: z.number(),
          }),
        )
        .optional(),
      reachableWithWindow: z.string().nullable(),
    })
    .optional(),
};

/**
 * Optional explicit `{from,to}` ISO date range that the comparison /
 * changepoint reads accept IN PLACE OF one of the five fixed trailing windows.
 * Bounds are inclusive; the read serves the range over the same rollup tier the
 * trailing windows use (see `rich-reads.ts`).
 */
export const dateRangeShape = z
  .object({
    from: isoDateTime(),
    to: isoDateTime(),
  })
  .describe(
    "An explicit inclusive date range. Use INSTEAD OF `window` for an arbitrary span (e.g. before vs after a date). Both bounds are ISO-8601 instants.",
  );
