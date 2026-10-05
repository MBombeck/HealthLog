/**
 * OpenAPI route module — v1.25 read-only insight signals.
 *
 * Three calm awareness reads built on existing engines:
 *   - GET /api/insights/health-status      baseline-drift (bands + changepoints)
 *   - GET /api/insights/breathing-screening sleep-breathing screening signal
 *   - GET /api/insights/labs-changes        "what changed since your last panel"
 *
 * Each is pure compute over the rollup / lab tier — no provider call. Labels
 * are resolved client-side from the type tokens, so the wire carries tokens
 * only. Part of the OpenAPI route table; aggregated in `./index.ts`.
 */
import { z } from "zod/v4";
import type { ZodOpenApiObject } from "zod-openapi";

import { dataEnvelope, recordRefusal, stdResponses } from "./shared";

const healthStatusResponse = z
  .object({
    present: z
      .boolean()
      .describe("True when at least one deviation or shift is surfaced."),
    deviations: z.array(
      z.object({
        type: z.string().describe("MeasurementType token."),
        value: z.number().describe("Today's value."),
        center: z.number().describe("Personal band center (median)."),
        low: z.number(),
        high: z.number(),
        direction: z.enum(["above", "below"]),
        basis: z
          .enum(["day", "sameHours"])
          .describe(
            "What `low`/`high` describe: the usual whole day (`day`), or the usual range for this time of day (`sameHours`), used for a day still in progress whose mean moves with the hour (glucose). Additive since v1.40.3.",
          ),
      }),
    ),
    shifts: z.array(
      z.object({
        metric: z.string().describe("MeasurementType token."),
        breakDate: z
          .string()
          .describe("YYYY-MM-DD of the new level's first day."),
        beforeMean: z.number(),
        afterMean: z.number(),
        direction: z.enum(["up", "down"]),
      }),
    ),
    generatedAt: z.string().describe("ISO-8601 instant the read was computed."),
  })
  .meta({
    id: "InsightsHealthStatus",
    description:
      "Vitals drifting from the user's personal normal — band deviations plus dated, sustained level shifts. Awareness only, never a diagnosis.",
  });

const breathingScreeningResponse = z
  .object({
    present: z.boolean(),
    nights: z.number().int().describe("Nights with a per-night index reading."),
    recentMeanIndex: z
      .number()
      .nullable()
      .describe("Mean of the index readings (lower-better); null when none."),
    trend: z
      .enum(["up", "down", "stable"])
      .nullable()
      .describe("Recent index vs the prior window; null when too few nights."),
    eventCount: z
      .number()
      .int()
      .describe("Device-flagged breathing-disturbance / apnea events."),
    classification: z
      .enum(["not-elevated", "elevated"])
      .nullable()
      .describe("The device's own classification; null when no data."),
    generatedAt: z.string(),
  })
  .meta({
    id: "InsightsBreathingScreening",
    description:
      "Sleep-breathing-disturbance screening signal — a screening signal only, never a diagnosis.",
  });

const labsChangesResponse = z
  .object({
    present: z.boolean(),
    latestDate: z
      .string()
      .nullable()
      .describe("YYYY-MM-DD of the most-recent panel."),
    previousDate: z
      .string()
      .nullable()
      .describe("YYYY-MM-DD of the prior panel."),
    changes: z.array(
      z.object({
        analyte: z.string(),
        unit: z.string(),
        latest: z.number(),
        previous: z.number(),
        delta: z.number().describe("Signed latest − previous."),
        direction: z.enum(["up", "down", "flat"]),
        status: z.enum(["in-range", "below", "above", "unknown"]),
      }),
    ),
    generatedAt: z.string(),
  })
  .meta({
    id: "InsightsLabsChanges",
    description:
      "Per-analyte change between the two most-recent numeric lab panels. Neutral framing, never a diagnosis.",
  });

export const insightsSignalPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/insights/health-status": {
    get: {
      tags: ["Insights"],
      summary: "Baseline-drift health status",
      description:
        "Surfaces vitals drifting from the user's personal normal — out-of-band deviations from the personal-baseline engine plus dated, sustained level shifts from the changepoint detector. Pure compute over the rollup tier; awareness only, never a diagnosis. Requires the insights module. Cookie or Bearer auth.",
      responses: {
        ...recordRefusal(),
        "200": {
          description: "The drift summary.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                healthStatusResponse,
                "InsightsHealthStatusEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/insights/breathing-screening": {
    get: {
      tags: ["Insights"],
      summary: "Sleep-breathing screening signal",
      description:
        "Summarises the last ~30 nights of the per-night sleep-breathing-disturbance index plus device-flagged events into a calm awareness read. A screening signal only — never a HealthLog diagnosis. Requires the insights module. Cookie or Bearer auth.",
      responses: {
        ...recordRefusal(),
        "200": {
          description: "The breathing-screening summary.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                breathingScreeningResponse,
                "InsightsBreathingScreeningEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/insights/labs-changes": {
    get: {
      tags: ["Insights"],
      summary: "What changed since your last lab panel",
      description:
        "Pairs the two most-recent numeric lab panels and reports each shared analyte's signed delta plus its reference-band standing. Absent when there are fewer than two panels or no analyte is shared. Neutral framing, never a diagnosis. Cookie or Bearer auth.",
      responses: {
        ...recordRefusal(),
        "200": {
          description: "The lab-change summary.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                labsChangesResponse,
                "InsightsLabsChangesEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
};
