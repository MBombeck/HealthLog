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
import {
  readUpstreamBody,
  secretsInUrl,
} from "@/lib/notifications/upstream-body";

/**
 * Send notification via ntfy (simple HTTP POST).
 * See https://docs.ntfy.sh/publish/
 *
 * Returns a structured `SendOutcome` so the dispatcher (v1.4.15)
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
    // Published as JSON to the server root rather than as a body with
    // headers to the topic URL. A header carries only Latin-1 (`fetch`
    // refuses anything above U+00FF, and ntfy reads a Latin-1 byte as invalid
    // UTF-8), so a Korean title or a Polish action label had to travel as an
    // RFC 2047 encoded word, and an `Actions` header encoded whole, URLs and
    // all, is not a form ntfy's action parser is documented to accept, so a
    // reminder with an Italian, Korean or Polish label risked a 400 and never
    // arrived. A JSON body is UTF-8 end to end and has no header encoding
    // at all (https://docs.ntfy.sh/publish/#publish-as-json).
    const url = `${config.serverUrl.replace(/\/$/, "")}/`;
    const message = buildNtfyMessage(config.topic, payload);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (config.authToken) {
      headers["Authorization"] = `Bearer ${config.authToken}`;
    }
    const body = JSON.stringify(message);

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
    // What the server said, for the test button. The topic is treated as a
    // secret too: on a public ntfy server it is the only access control.
    const upstreamBody = await readUpstreamBody(res, [
      config.authToken,
      config.topic,
      ...secretsInUrl(config.serverUrl),
    ]);
    return {
      ok: false,
      statusCode: res.status,
      hardReject: classified.hardReject,
      reason: classified.reason,
      ...(upstreamBody ? { upstreamBody } : {}),
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
    const failureCode =
      err instanceof SafeFetchError && !policyRefused
        ? err.kind === "timeout"
          ? "timeout"
          : "connection_failed"
        : undefined;
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
      ...(failureCode ? { failureCode } : {}),
    };
  }
}

/** ntfy shows at most three actions per notification. */
const NTFY_MAX_ACTIONS = 3;

/** One `http` action button in ntfy's JSON form. */
export interface NtfyHttpAction {
  action: "http";
  label: string;
  url: string;
  method: "POST";
  clear: true;
}

/** The JSON publish body (https://docs.ntfy.sh/publish/#publish-as-json). */
export interface NtfyMessage {
  topic: string;
  title: string;
  message: string;
  priority: 3 | 4 | 5;
  tags: string[];
  click?: string;
  actions?: NtfyHttpAction[];
}

/**
 * The message ntfy publishes for a payload.
 *
 * - Priority: an explicitly urgent payload escalates to ntfy's top priority
 *   (5, max) so it bypasses the relay's batching and surfaces loudest;
 *   MEDICATION_REMINDER keeps its long-standing high (4); the rest stay at
 *   the default (3).
 * - Tags: discreet mode (cycle privacy) collapses them to a generic tag,
 *   because tags are visible on the lock screen and would name the cycle
 *   event. An urgent, non-discreet event also carries `warning` so the entry
 *   renders as an alert.
 * - Click: tapping the notification opens the resolved tap URL; absent when
 *   the operator configured no public origin.
 * - Actions: the payload's quick answers, at most three, as `http` POST
 *   buttons with `clear` so an answered reminder leaves the shade. The token
 *   in each URL is the request's only credential (see `action-token.ts`).
 */
export function buildNtfyMessage(
  topic: string,
  payload: NotificationPayload,
): NtfyMessage {
  const urgent = isUrgentPayload(payload) && payload.urgent === true;
  const priority = urgent
    ? 5
    : payload.eventType === "MEDICATION_REMINDER"
      ? 4
      : 3;
  const eventTag = payload.discreet
    ? "reminder"
    : payload.eventType.toLowerCase().replace(/_/g, "-");
  const message: NtfyMessage = {
    topic,
    title: plainPushText(payload.title, payload.eventType),
    // Plain text only, and no emoji on routine reminders.
    message: plainPushText(stripHtml(payload.message), payload.eventType),
    priority,
    tags: urgent && !payload.discreet ? ["warning", eventTag] : [eventTag],
  };
  if (payload.tap?.url) message.click = payload.tap.url;
  const actions = buildNtfyActions(payload);
  if (actions.length > 0) message.actions = actions;
  return message;
}

/** The payload's quick answers as ntfy `http` actions, at most three. */
export function buildNtfyActions(
  payload: Pick<NotificationPayload, "quickActions">,
): NtfyHttpAction[] {
  return (payload.quickActions ?? [])
    .slice(0, NTFY_MAX_ACTIONS)
    .map((action) => ({
      action: "http",
      label: action.label.trim() || "?",
      url: action.url,
      method: "POST",
      clear: true,
    }));
}
