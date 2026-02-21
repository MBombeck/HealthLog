import { z } from "zod/v4";
import { EVENT_TYPES } from "@/lib/notifications/types";

export const notificationPreferenceSchema = z.object({
  channelId: z.string().min(1),
  eventType: z.enum(EVENT_TYPES),
  enabled: z.boolean(),
});

export const ntfySettingsSchema = z.object({
  serverUrl: z
    .url("Ungültige Server-URL")
    .max(200)
    .optional()
    .or(z.literal("")),
  topic: z.string().max(100).optional().or(z.literal("")),
  authToken: z.string().max(200).optional().or(z.literal("")),
  enabled: z.boolean(),
});

export const webPushSubscriptionSchema = z.object({
  endpoint: z.url("Ungültiger Endpoint"),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
});
