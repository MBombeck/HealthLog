import { z } from "zod/v4";
import { isPublicUrl } from "@/lib/validations/notifications";

export const moodLogCredentialsSchema = z.object({
  url: z
    .string()
    .url()
    .max(500)
    // SSRF guard: stored URL must point at a public host. The sync
    // worker fetches from this URL with the user's apiKey in the
    // Authorization header, so a stored RFC1918 / link-local target
    // would let any user pull cloud-metadata or local-network data
    // back through their account.
    .refine((u) => isPublicUrl(u), {
      message: "URL must point at a public host (no RFC1918 / link-local)",
    }),
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
export type MoodLogWebhookPayload = z.infer<typeof moodLogWebhookPayloadSchema>;
export type MoodLogSyncResponse = z.infer<typeof moodLogSyncResponseSchema>;

// --- CRUD schemas for mood entries ---

export const moodLevelEnum = z.enum([
  "SUPER_GUT",
  "GUT",
  "OKAY",
  "SCHLECHT",
  "LAUSIG",
]);

export const moodSourceEnum = z.enum([
  "MANUAL",
  "MOODLOG",
  "WEB",
  "TELEGRAM",
  "DAYLIO",
]);

const MOOD_SCORE_MAP: Record<string, number> = {
  SUPER_GUT: 5,
  GUT: 4,
  OKAY: 3,
  SCHLECHT: 2,
  LAUSIG: 1,
};

export function getScoreForMood(mood: string): number {
  return MOOD_SCORE_MAP[mood] ?? 3;
}

export const createMoodEntrySchema = z.object({
  mood: moodLevelEnum,
  tags: z.array(z.string().max(50)).max(20).optional(),
  moodLoggedAt: z.iso.datetime({ offset: true }).transform((s) => new Date(s)),
  source: moodSourceEnum.optional().default("MANUAL"),
});

export const updateMoodEntrySchema = z.object({
  mood: moodLevelEnum.optional(),
  tags: z.array(z.string().max(50)).max(20).nullable().optional(),
  moodLoggedAt: z.iso
    .datetime({ offset: true })
    .transform((s) => new Date(s))
    .optional(),
});

export const listMoodEntriesSchema = z.object({
  mood: moodLevelEnum.optional(),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(500).optional().default(100),
  offset: z.coerce.number().int().min(0).optional().default(0),
  sortBy: z
    .enum(["date", "mood", "score", "moodLoggedAt", "source"])
    .optional()
    .default("moodLoggedAt"),
  sortDir: z.enum(["asc", "desc"]).optional().default("desc"),
});

export type CreateMoodEntryInput = z.infer<typeof createMoodEntrySchema>;
export type UpdateMoodEntryInput = z.infer<typeof updateMoodEntrySchema>;
export type ListMoodEntriesInput = z.infer<typeof listMoodEntriesSchema>;
