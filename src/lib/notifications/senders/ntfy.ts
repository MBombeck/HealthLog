import type {
  NtfyChannelConfig,
  NotificationPayload,
} from "@/lib/notifications/types";

/**
 * Send notification via ntfy (simple HTTP POST).
 * See https://docs.ntfy.sh/publish/
 */
export async function sendViaNtfy(
  config: NtfyChannelConfig,
  payload: NotificationPayload,
): Promise<boolean> {
  try {
    const url = `${config.serverUrl.replace(/\/$/, "")}/${encodeURIComponent(config.topic)}`;

    const headers: Record<string, string> = {
      Title: payload.title,
      Priority:
        payload.eventType === "MEDICATION_REMINDER" ? "high" : "default",
      Tags: payload.eventType.toLowerCase().replace(/_/g, "-"),
    };

    if (config.authToken) {
      headers["Authorization"] = `Bearer ${config.authToken}`;
    }

    // Strip HTML tags for ntfy (plain text only)
    const body = payload.message.replace(/<[^>]*>/g, "");

    const res = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(5000),
    });

    return res.ok;
  } catch {
    return false;
  }
}
