import { z } from "zod/v4";

import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { capFields, capped, cappedOutput } from "@/lib/mcp/capped";
import { READ_ONLY_ANNOTATIONS, type McpToolDefinition } from "./types";

/** Defensive cap, mirrors `GET /api/insights/ecg`'s `MAX_RECORDINGS`. */
const MAX_ECG_RECORDINGS = 200;

/**
 * Output schema for `get_ecg_recordings` — METADATA only. `waveformEncrypted`
 * is never selected by the underlying query, let alone shaped here.
 * `classification` is the device's own verbatim verdict; `classificationSource`
 * is a fixed literal so a caller can never mistake it for a HealthLog-derived
 * read.
 */
const getEcgRecordingsOutput: z.ZodRawShape = {
  present: z.boolean(),
  reason: z.string().optional(),
  classificationSource: z.literal("device").optional(),
  recordings: z
    .array(
      z.object({
        id: z.string(),
        recordedAt: z.string(),
        durationSeconds: z.number().nullable(),
        samplingFrequency: z.number(),
        sampleCount: z.number(),
        averageHeartRate: z.number().nullable(),
        lead: z.string().nullable(),
        classification: z.string().nullable(),
        source: z.string(),
        hasWaveform: z.boolean(),
      }),
    )
    .optional(),
  ...cappedOutput,
};

export const getEcgRecordingsTool: McpToolDefinition = {
  name: "get_ecg_recordings",
  title: "Get ECG recordings",
  description:
    "Fetch METADATA for the user's own ECG recordings — recorded time, duration, sampling rate, sample count, average heart rate, lead, and the DEVICE's own rhythm classification. NEVER reads or returns the waveform (that stays app-only). Non-diagnostic: this reflects ONLY the classification result the recording device's own certified on-device algorithm produced — HealthLog never re-classifies an ECG and never forms a diagnosis from it; `classificationSource` is always the fixed literal 'device'. Device data: no AI switch and no module gate apply. Returns { present: false } when no recordings exist.",
  inputShape: {},
  annotations: READ_ONLY_ANNOTATIONS,
  outputShape: getEcgRecordingsOutput,
  async run(ctx) {
    // Device data, served whatever the AI switches or the AI analysis
    // opt-out say, like `GET /api/insights/ecg`.
    const { rows, cap } = await capped(MAX_ECG_RECORDINGS, (take) =>
      prisma.ecgRecording.findMany({
        where: { userId: ctx.userId },
        // Everything EXCEPT `waveformEncrypted` — mirrors `GET
        // /api/insights/ecg`'s own select exactly; no decrypt ever happens
        // on this path.
        select: {
          id: true,
          recordedAt: true,
          durationSeconds: true,
          samplingFrequency: true,
          sampleCount: true,
          averageHeartRate: true,
          lead: true,
          rhythmClassification: true,
          source: true,
        },
        orderBy: [{ recordedAt: "desc" }, { id: "desc" }],
        take,
      }),
    );

    if (rows.length === 0) {
      annotate({
        action: { name: "mcp.tool.invoked" },
        meta: { tool: "get_ecg_recordings", present: false },
      });
      return { present: false, reason: "no_data" };
    }

    const recordings = rows.map((r) => ({
      id: r.id,
      recordedAt: r.recordedAt.toISOString(),
      durationSeconds: r.durationSeconds,
      samplingFrequency: r.samplingFrequency,
      sampleCount: r.sampleCount,
      averageHeartRate: r.averageHeartRate,
      lead: r.lead,
      classification: r.rhythmClassification,
      source: r.source,
      // A `ts-` fallback event carries a verdict but no signal to fetch.
      hasWaveform: r.sampleCount > 0,
    }));

    annotate({
      action: { name: "mcp.tool.invoked" },
      meta: { tool: "get_ecg_recordings", present: true },
    });
    return {
      present: true,
      classificationSource: "device" as const,
      recordings,
      ...capFields(cap),
    };
  },
};
