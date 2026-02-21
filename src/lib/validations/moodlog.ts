import { z } from "zod/v4";

export const moodLogCredentialsSchema = z.object({
  url: z.string().url().max(500),
  apiKey: z.string().min(1).max(200),
});

export const moodLogWebhookPayloadSchema = z.object({
  event: z.enum(["mood.created", "mood.updated", "mood.deleted"]),
  timestamp: z.string().datetime(),
  entry: z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    time: z.string().datetime(),
    mood: z.enum(["SUPER_GUT", "GUT", "OKAY", "SCHLECHT", "LAUSIG"]),
    score: z.number().int().min(1).max(5),
    tags: z.array(z.string()).max(50).optional(),
    loggedVia: z.enum(["WEB", "TELEGRAM", "DAYLIO"]).optional(),
  }),
});

export const moodLogSyncResponseSchema = z.object({
  version: z.string(),
  entries: z.array(
    z.object({
      date: z.string(),
      time: z.string(),
      mood: z.string(),
      score: z.number(),
      tags: z.array(z.string()).optional(),
      loggedVia: z.string().optional(),
    }),
  ),
});

export type MoodLogCredentials = z.infer<typeof moodLogCredentialsSchema>;
export type MoodLogWebhookPayload = z.infer<
  typeof moodLogWebhookPayloadSchema
>;
export type MoodLogSyncResponse = z.infer<
  typeof moodLogSyncResponseSchema
>;
