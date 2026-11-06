/**
 * The person-defined symptom lines of `GET /api/timeline` (#981): one
 * symptom's points, bucket means of its day peaks over the days it was
 * logged, and the symptoms the record offers. Server and OpenAPI side only,
 * like `./wire-schemas.ts`, which places them in the timeline's response.
 */
import { z } from "zod/v4";

import { TIMELINE_SYMPTOM_SCALE } from "./contract";
import { dateKeySchema } from "./date-key-schema";

const timelineSymptomPoint = z
  .object({
    t: dateKeySchema.describe("The bucket's first day."),
    mean: z
      .number()
      .min(TIMELINE_SYMPTOM_SCALE.min)
      .max(TIMELINE_SYMPTOM_SCALE.max)
      .describe(
        "The mean of the bucket's day values over the days the symptom was logged. A day's value is the highest intensity (0 to 10) logged on it; a day without an entry is not a zero and does not count.",
      ),
    count: z
      .number()
      .int()
      .min(1)
      .describe(
        "Days the symptom was logged in the bucket, the days behind the mean. Clients draw a point from fewer than three as thin.",
      ),
  })
  .meta({ id: "TimelineSymptomPoint" });

export const timelineSymptomSeries = z
  .object({
    key: z.string().describe("`symptom:<definitionId>`, as named in `values`."),
    definitionId: z.string(),
    label: z
      .string()
      .nullable()
      .describe(
        "The person's own name for the symptom. Null when it cannot be read; the client words a stand-in.",
      ),
    icon: z
      .string()
      .nullable()
      .describe("The symptom's icon name; null for the default glyph."),
    isActive: z
      .boolean()
      .describe(
        "False for a hidden symptom: no longer offered for entry, its history kept and drawn.",
      ),
    scale: z
      .object({
        min: z.literal(TIMELINE_SYMPTOM_SCALE.min),
        max: z.literal(TIMELINE_SYMPTOM_SCALE.max),
      })
      .describe(
        "The fixed scale the line is drawn on, the intensity scale, whatever the window holds.",
      ),
    points: z
      .array(timelineSymptomPoint)
      .describe(
        "Buckets of the response's `bucket` with at least one logged day, oldest first. A bucket without one is absent, never zero and never interpolated.",
      ),
  })
  .meta({ id: "TimelineSymptomSeries" });

export const timelineSymptomOption = z
  .object({
    key: z.string().describe("`symptom:<definitionId>`, to name in `values`."),
    definitionId: z.string(),
    label: z.string().nullable(),
    icon: z.string().nullable(),
    isActive: z.boolean(),
  })
  .meta({ id: "TimelineSymptomOption" });
