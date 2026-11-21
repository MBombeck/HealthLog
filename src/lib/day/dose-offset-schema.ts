/**
 * The `doseOffset` field of a day event (`withDoseOffsets` in
 * `dose-offsets.ts`), kept beside the day's wire schemas rather than in them
 * so that file stays inside its size.
 */
import { z } from "zod/v4";

export const dayDoseOffsetField = z
  .object({
    intakeId: z.string().describe("The anchoring intake event's id."),
    title: z.string().describe("The medication's name."),
    minutes: z
      .number()
      .int()
      .describe(
        "Minutes from the dose to the symptom. Positive: after the dose; negative: before it, when the day holds no earlier dose.",
      ),
  })
  .optional()
  .describe(
    "Symptoms only, and only on a day with a timed dose: the symptom's distance from the nearest dose taken at or before it, else the nearest one after it. A distance in time and nothing more; never a cause.",
  );
