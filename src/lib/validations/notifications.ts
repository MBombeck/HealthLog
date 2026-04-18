import { z } from "zod/v4";
import { EVENT_TYPES } from "@/lib/notifications/types";

export const notificationPreferenceSchema = z.object({
  channelId: z.string().min(1),
  eventType: z.enum(EVENT_TYPES),
  enabled: z.boolean(),
});

// Block private/internal network URLs to prevent SSRF. Exported so other
// server-initiated egress (AI providers, webhooks) can reuse it.
export function isPublicUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
      return false;
    const h = parsed.hostname;
    if (
      h === "169.254.169.254" ||
      h === "127.0.0.1" ||
      h === "[::1]" ||
      h === "0.0.0.0" ||
      h === "localhost" ||
      h.startsWith("10.") ||
      h.startsWith("192.168.") ||
      h.endsWith(".internal") ||
      h.endsWith(".local")
    )
      return false;
    // 172.16.0.0/12
    if (h.startsWith("172.")) {
      const second = parseInt(h.split(".")[1] ?? "0", 10);
      if (second >= 16 && second <= 31) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export const ntfySettingsSchema = z.object({
  serverUrl: z
    .url("Ungültige Server-URL")
    .max(200)
    .refine((url) => isPublicUrl(url), "Server-URL darf nicht auf interne Netzwerke zeigen")
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
