import type {
  NtfyChannelConfig,
  NotificationPayload,
} from "@/lib/notifications/types";
import type { SendOutcome } from "@/lib/notifications/retry-policy";
import { classifyHttpStatus } from "@/lib/notifications/retry-policy";
import { getEvent } from "@/lib/logging/context";
import { recordPushAttempt } from "@/lib/notifications/senders/push-attempt-record";

/**
 * Send notification via ntfy (simple HTTP POST).
 * See https://docs.ntfy.sh/publish/
 *
 * Returns a structured `SendOutcome` so the dispatcher (v1.4.15 Phase B3)
 * can distinguish hard rejects (HTTP 410, topic deleted) from soft errors
 * (5xx, 429, network timeout) and apply the right retry / auto-disable
 * policy.
 */
export async function sendViaNtfy(
  config: NtfyChannelConfig,
  payload: NotificationPayload,
): Promise<SendOutcome> {
  const start = performance.now();
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

    getEvent()?.addExternalCall({
      service: "ntfy",
      method: "sendNotification",
      duration_ms: Math.round(performance.now() - start),
      status: res.status,
    });

    if (res.ok) {
      recordPushAttempt({
        userId: payload.userId,
        channel: "NTFY",
        eventType: payload.eventType,
        result: "ok",
      });
      return { ok: true, statusCode: res.status };
    }
    const classified = classifyHttpStatus(res.status, "ntfy");
    recordPushAttempt({
      userId: payload.userId,
      channel: "NTFY",
      eventType: payload.eventType,
      result: "error",
      reason: classified.reason,
    });
    return {
      ok: false,
      statusCode: res.status,
      hardReject: classified.hardReject,
      reason: classified.reason,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "request_failed";
    getEvent()?.addExternalCall({
      service: "ntfy",
      method: "sendNotification",
      duration_ms: Math.round(performance.now() - start),
      error: message,
    });
    recordPushAttempt({
      userId: payload.userId,
      channel: "NTFY",
      eventType: payload.eventType,
      result: "error",
      reason: "ntfy_network_error",
    });
    return {
      ok: false,
      hardReject: false,
      reason: "ntfy_network_error",
      message,
    };
  }
}
