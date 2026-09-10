import type {
  NtfyChannelConfig,
  NotificationPayload,
} from "@/lib/notifications/types";
import type { SendOutcome } from "@/lib/notifications/retry-policy";
import { classifyHttpStatus } from "@/lib/notifications/retry-policy";
import { getEvent } from "@/lib/logging/context";
import { recordPushAttemptForPayload } from "@/lib/notifications/senders/push-attempt-record";
import { safeFetch, SafeFetchError } from "@/lib/safe-fetch";
import { plainPushText } from "@/lib/notifications/strip-emoji";
import { stripHtml } from "@/lib/notifications/strip-html";
import { isUrgentPayload } from "@/lib/notifications/types";
import {
  annotatePrivateOriginEgress,
  evaluateNotificationTarget,
  PRIVATE_ORIGIN_NOT_APPROVED_CODE,
} from "@/lib/notifications/egress-policy";
import type { OriginReason } from "@/lib/private-origin-policy";

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
  const userId = payload.recipientUserId ?? payload.userId;
  const start = performance.now();
  // Set when the policy itself refuses, so the outcome can say which of the
  // two refusals it was: an origin the operator could list, or one no grant
  // can open.
  let policyReason: OriginReason | null = null;
  try {
    const url = `${config.serverUrl.replace(/\/$/, "")}/${encodeURIComponent(config.topic)}`;

    // v1.18.4 — an explicitly urgent payload escalates to ntfy's top
    // priority (`5` / max) so it bypasses the relay's batching and surfaces
    // loudest; MEDICATION_REMINDER keeps its long-standing `high` (4); the
    // rest stay `default` (3). `urgent` also adds a tag so the lock-screen
    // entry reads as an alert (unless discreet privacy collapses tags).
    const urgent = isUrgentPayload(payload) && payload.urgent === true;
    const priority = urgent
      ? "5"
      : payload.eventType === "MEDICATION_REMINDER"
        ? "high"
        : "default";
    const eventTag = payload.discreet
      ? "reminder"
      : payload.eventType.toLowerCase().replace(/_/g, "-");
    const headers: Record<string, string> = {
      Title: plainPushText(payload.title, payload.eventType),
      Priority: priority,
      // Discreet mode (cycle privacy): the X-Tags header is visible on the
      // lock screen, so collapse it to a generic tag instead of leaking the
      // cycle event name. An urgent (non-discreet) event also carries a
      // `warning` tag so the entry renders as an alert.
      Tags: urgent && !payload.discreet ? `warning,${eventTag}` : eventTag,
    };

    if (config.authToken) {
      headers["Authorization"] = `Bearer ${config.authToken}`;
    }

    // Strip HTML tags for ntfy (plain text only) + emoji on routine reminders
    const body = plainPushText(stripHtml(payload.message), payload.eventType);

    // The DNS-rebinding pin (issue #217) sits on top of the input-time
    // guard enforced when the user saved the serverUrl; the authToken would
    // otherwise leak on a rebinding flip to a private address. A server the
    // operator listed in NOTIFICATION_PRIVATE_ORIGINS (#947) runs under the
    // operator-approved pin instead — same resolver pin, redirects
    // forbidden, loopback and metadata refused. Same verdict function as
    // the settings routes and the webhook sender.
    const policy = evaluateNotificationTarget(url);
    if (!policy.allowed || !policy.canonicalOrigin) {
      policyReason = policy.reasonCode;
      throw new SafeFetchError(
        "ntfy server refused by the notification origin policy",
        "private_host",
      );
    }
    if (policy.privateOriginApproved) {
      annotatePrivateOriginEgress("ntfy", policy.canonicalOrigin);
    }

    const res = await safeFetch(
      url,
      {
        method: "POST",
        headers,
        body,
      },
      {
        timeoutMs: 5_000,
        requirePublicHost: !policy.privateOriginApproved,
        ...(policy.privateOriginApproved
          ? { operatorApprovedPrivateOrigin: policy.canonicalOrigin }
          : {}),
      },
    );

    getEvent()?.addExternalCall({
      service: "ntfy",
      method: "sendNotification",
      duration_ms: Math.round(performance.now() - start),
      status: res.status,
    });

    if (res.ok) {
      recordPushAttemptForPayload(payload, userId, {
        userId: payload.userId,
        channel: "NTFY",
        eventType: payload.eventType,
        result: "ok",
      });
      return { ok: true, statusCode: res.status };
    }
    const classified = classifyHttpStatus(res.status, "ntfy");
    recordPushAttemptForPayload(payload, userId, {
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
    // A policy refusal is not a network fault (see the webhook sender): soft
    // classification, its own reason, and a code the test route can forward.
    const policyRefused =
      err instanceof SafeFetchError && err.kind === "private_host";
    const reason = policyRefused
      ? "ntfy_private_origin_refused"
      : "ntfy_network_error";
    getEvent()?.addExternalCall({
      service: "ntfy",
      method: "sendNotification",
      duration_ms: Math.round(performance.now() - start),
      error: message,
    });
    recordPushAttemptForPayload(payload, userId, {
      userId: payload.userId,
      channel: "NTFY",
      eventType: payload.eventType,
      result: "error",
      reason,
    });
    return {
      ok: false,
      hardReject: false,
      reason,
      message,
      ...(policyRefused
        ? { errorCode: policyReason ?? PRIVATE_ORIGIN_NOT_APPROVED_CODE }
        : {}),
    };
  }
}
