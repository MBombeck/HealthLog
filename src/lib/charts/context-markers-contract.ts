/**
 * The wire of `GET /api/insights/context`: what happened around a metric,
 * for the marks a metric chart draws over its line (medication changes,
 * illness episodes, cycle phases). Client-safe: the schemas and types only,
 * the loader is `./context-markers.ts`.
 *
 * Every date is a local calendar day (`YYYY-MM-DD`) in the record's zone,
 * cut on the server, so a chart places a mark on the day the timeline shows
 * it on, whatever zone the browser runs in.
 */
import { z } from "zod/v4";

import { dateKeySchema } from "@/lib/day/date-key-schema";

/** What a medication mark says happened on its day. */
export const CHART_CONTEXT_MEDICATION_KINDS = [
  "start",
  "stop",
  "doseChange",
  "pause",
  "resume",
] as const;
export type ChartContextMedicationKind =
  (typeof CHART_CONTEXT_MEDICATION_KINDS)[number];

export const CHART_CONTEXT_CYCLE_PHASES = [
  "MENSTRUAL",
  "FOLLICULAR",
  "OVULATORY",
  "LUTEAL",
] as const;
export type ChartContextCyclePhase =
  (typeof CHART_CONTEXT_CYCLE_PHASES)[number];

export const chartContextQuerySchema = z
  .object({
    from: dateKeySchema
      .optional()
      .describe("First day of the window. Omitted: the whole record."),
    to: dateKeySchema
      .optional()
      .describe("Last day of the window. Omitted: today."),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, {
    message: "`from` must not be after `to`",
    path: ["from"],
  });

const medicationMark = z
  .object({
    id: z.string().describe("Unique within the answer."),
    medicationId: z.string(),
    kind: z.enum(CHART_CONTEXT_MEDICATION_KINDS),
    date: dateKeySchema,
    estimated: z
      .boolean()
      .describe(
        "A start with no stated start date: the day of the first logged dose stands in.",
      ),
    name: z.string(),
    dose: z
      .string()
      .nullable()
      .describe("The dose from this day, on a dose change or a start."),
    href: z.string().describe("The in-app page of the record."),
  })
  .meta({ id: "ChartContextMedicationMark" });

const illnessSpan = z
  .object({
    id: z.string(),
    start: dateKeySchema,
    end: dateKeySchema
      .nullable()
      .describe("Null while the episode is still open."),
    label: z.string(),
    href: z.string(),
  })
  .meta({ id: "ChartContextIllnessSpan" });

const cyclePhaseSpan = z
  .object({
    phase: z.enum(CHART_CONTEXT_CYCLE_PHASES),
    start: dateKeySchema,
    end: dateKeySchema.describe("Inclusive."),
  })
  .meta({ id: "ChartContextCyclePhase" });

export const chartContextResponseSchema = z
  .object({
    today: dateKeySchema.describe("Today in the record's zone."),
    medications: z
      .array(medicationMark)
      .describe(
        "Starts, stops, dose changes, pauses and resumptions, oldest first. Empty without the medications module or section.",
      ),
    illnesses: z
      .array(illnessSpan)
      .describe(
        "Acute illness episodes, oldest first. A chronic condition is not a span on a chart and is left out. Empty without the illness module or section.",
      ),
    cyclePhases: z
      .array(cyclePhaseSpan)
      .describe(
        "Phases of the observed cycles, oldest first, the open cycle up to today. Empty without the cycle module or section.",
      ),
  })
  .meta({ id: "ChartContext" });

export type ChartContextResponse = z.infer<typeof chartContextResponseSchema>;
export type ChartContextMedicationMark =
  ChartContextResponse["medications"][number];
export type ChartContextIllnessSpan = ChartContextResponse["illnesses"][number];
export type ChartContextCyclePhaseSpan =
  ChartContextResponse["cyclePhases"][number];
