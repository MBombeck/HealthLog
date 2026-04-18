import { z } from "zod/v4";
import { METRIC_BOUNDS, type ThresholdMetric } from "@/lib/analytics/effective-range";

const metricKeys = Object.keys(METRIC_BOUNDS) as ThresholdMetric[];

function rangeSchemaFor(metric: ThresholdMetric) {
  const { min, max } = METRIC_BOUNDS[metric];
  return z
    .object({
      min: z.number().min(min).max(max),
      max: z.number().min(min).max(max),
    })
    .refine((v) => v.min < v.max, {
      message: "min must be strictly less than max",
    });
}

/**
 * Validates a partial override payload from the user.
 * Unknown keys are rejected. Each range must be within the metric's
 * physiological bounds and min < max.
 */
export const thresholdsUpdateSchema = z
  .object(
    Object.fromEntries(
      metricKeys.map((m) => [m, rangeSchemaFor(m).optional()]),
    ),
  )
  .strict();

export type ThresholdsUpdatePayload = z.infer<typeof thresholdsUpdateSchema>;

/** Metric list kept exported here so admin and settings UI stay in sync. */
export const ALL_METRICS: ThresholdMetric[] = metricKeys;
