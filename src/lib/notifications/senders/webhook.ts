import type {
  WebhookChannelConfig,
  NotificationPayload,
} from "@/lib/notifications/types";
import type { SendOutcome } from "@/lib/notifications/retry-policy";
import { classifyHttpStatus } from "@/lib/notifications/retry-policy";
import { getEvent } from "@/lib/logging/context";
import { recordPushAttemptForPayload } from "@/lib/notifications/senders/push-attempt-record";
import { safeFetch, SafeFetchError } from "@/lib/safe-fetch";
import { plainPushText } from "@/lib/notifications/strip-emoji";
import { stripHtml } from "@/lib/notifications/strip-html";
import {
  annotatePrivateOriginEgress,
  evaluateNotificationTarget,
  PRIVATE_ORIGIN_NOT_APPROVED_CODE,
} from "@/lib/notifications/egress-policy";
import type { OriginReason } from "@/lib/private-origin-policy";

/**
 * Send a notification via a generic outbound webhook (v1.17.1).
 *
 * The user supplies a public URL (and optionally one custom header — e.g.
 * `Authorization: Bearer <token>` for Gotify). We POST a small JSON envelope
 * that Gotify / Discord / Slack / Matrix-bridge / Home Assistant / any homelab
 * relay can consume. The body is plain text (no markdown — hard rule); the
 * `title`/`message` fields are stripped of HTML + decorative emoji on routine
 * reminders exactly like the ntfy sender.
 *
 * Outbound goes through `safeFetch` with the connect-time DNS-rebinding pin
 * because the host is user-supplied; the optional shared-secret header would
 * otherwise leak on a rebinding flip to a private address. A public target
 * runs under the public pin. An origin the operator listed in
 * `NOTIFICATION_PRIVATE_ORIGINS` (#947) runs under the operator-approved pin
 * instead: still resolved and pinned inside the connector, redirects
 * forbidden, loopback and metadata answers refused. The verdict comes from
 * `evaluateNotificationTarget`, the same function the settings routes use,
 * so the test button and the dispatcher cannot disagree.
 *
 * Returns a `SendOutcome` so the dispatcher can distinguish hard rejects
 * (404/410 endpoint gone, 401/403 secret wrong) from soft errors (5xx, 429,
 * network timeout) and apply the right retry / auto-disable policy.
 */
export async function sendViaWebhook(
  config: WebhookChannelConfig,
  payload: NotificationPayload,
): Promise<SendOutcome> {
  const userId = payload.recipientUserId ?? payload.userId;
  const start = performance.now();
  // Set when the policy itself refuses, so the outcome can say which of the
  // two refusals it was: an origin the operator could list, or one no grant
  // can open.
  let policyReason: OriginReason | null = null;
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (config.headerName && config.headerValue) {
      headers[config.headerName] = config.headerValue;
    }

    // Plain-text envelope. The `title` field doubles as Gotify's `title` and
    // Discord/Slack ignore unknown keys, so a single shape covers the common
    // relays. Discreet mode (cycle privacy) is honoured by the title/body
    // already being masked upstream; we also send a generic `eventType` tag so
    // a relay rule can route without leaking the cycle event name.
    const body = JSON.stringify({
      title: plainPushText(payload.title, payload.eventType),
      message: plainPushText(stripHtml(payload.message), payload.eventType),
      eventType: payload.discreet ? "reminder" : payload.eventType,
      // v1.18.4 — an explicitly urgent event maps to `urgent` so a relay
      // rule (Gotify priority, Discord mention, Home Assistant automation)
      // can escalate; MEDICATION_REMINDER keeps `high`; the rest `default`.
      priority:
        payload.urgent === true
          ? "urgent"
          : payload.eventType === "MEDICATION_REMINDER"
            ? "high"
            : "default",
    });

    const policy = evaluateNotificationTarget(config.url);
    if (!policy.allowed || !policy.canonicalOrigin) {
      policyReason = policy.reasonCode;
      throw new SafeFetchError(
        "webhook target refused by the notification origin policy",
        "private_host",
      );
    }
    if (policy.privateOriginApproved) {
      annotatePrivateOriginEgress("webhook", policy.canonicalOrigin);
    }

    const res = await safeFetch(
      config.url,
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
      service: "webhook",
      method: "sendNotification",
      duration_ms: Math.round(performance.now() - start),
      status: res.status,
    });

    if (res.ok) {
      recordPushAttemptForPayload(payload, userId, {
        userId: payload.userId,
        channel: "WEBHOOK",
        eventType: payload.eventType,
        result: "ok",
      });
      return { ok: true, statusCode: res.status };
    }
    const classified = classifyHttpStatus(res.status, "webhook");
    recordPushAttemptForPayload(payload, userId, {
      userId: payload.userId,
      channel: "WEBHOOK",
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
    // A policy refusal is not a network fault: the target is on a private
    // network the operator has not listed. It keeps the soft classification
    // (delivery resumes the moment the origin is listed) but carries its own
    // reason so the ledger and the test button can say why.
    const policyRefused =
      err instanceof SafeFetchError && err.kind === "private_host";
    const reason = policyRefused
      ? "webhook_private_origin_refused"
      : "webhook_network_error";
    getEvent()?.addExternalCall({
      service: "webhook",
      method: "sendNotification",
      duration_ms: Math.round(performance.now() - start),
      error: message,
    });
    recordPushAttemptForPayload(payload, userId, {
      userId: payload.userId,
      channel: "WEBHOOK",
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
