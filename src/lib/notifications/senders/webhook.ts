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
import {
  readUpstreamBody,
  secretsInHeaderValue,
  secretsInUrl,
} from "@/lib/notifications/upstream-body";

type PriorityBand = "urgent" | "high" | "default";

/**
 * v1.18.4: an explicitly urgent event is `urgent` so a relay rule can
 * escalate; MEDICATION_REMINDER keeps `high`; the rest `default`.
 */
function priorityBand(payload: NotificationPayload): PriorityBand {
  if (payload.urgent === true) return "urgent";
  if (payload.eventType === "MEDICATION_REMINDER") return "high";
  return "default";
}

/**
 * Gotify's priority is an integer, and its Android client files a message
 * into a notification channel by it (`convertPriorityToChannel` in
 * gotify/android): below 1 minimum importance, 1-3 low (no sound), 4-7
 * default (sound), 8 and above high (sound, vibration, and a heads-up banner).
 *
 * The bands mirror what the ntfy sender asks for:
 *  - `default` → 5: audible, like ntfy's default. Not 1-3, which would
 *    make every routine reminder silent.
 *  - `high` (medication reminders) → 8: the lowest value that reaches the
 *    heads-up channel, as ntfy's `high` pops over.
 *  - `urgent` → 10: the same Android channel as 8, and the top of the scale
 *    for any client or rule that orders or filters by priority, as ntfy's 5.
 */
const GOTIFY_PRIORITY: Record<PriorityBand, number> = {
  default: 5,
  high: 8,
  urgent: 10,
};

/**
 * The request body for the configured format.
 *
 * Discreet mode (cycle privacy) is honoured the same way in both: the title
 * and message arrive already masked upstream, every text field (including the
 * generic body's `content` and `text`) is built from them, and the event name
 * a relay could route on is replaced by the generic `reminder`.
 */
export function buildWebhookBody(
  config: Pick<WebhookChannelConfig, "format">,
  payload: NotificationPayload,
): string {
  const title = plainPushText(payload.title, payload.eventType);
  const message = plainPushText(stripHtml(payload.message), payload.eventType);
  const eventType = payload.discreet ? "reminder" : payload.eventType;
  const band = priorityBand(payload);

  if (config.format === "gotify") {
    return JSON.stringify({
      title,
      message,
      priority: GOTIFY_PRIORITY[band],
      extras: {
        // Plain text, stated rather than left to the client default: the
        // body is never markdown (hard rule).
        "client::display": { contentType: "text/plain" },
        "healthlog::event": { type: eventType },
      },
    });
  }

  // Generic envelope. The first four fields are unchanged since v1.18.4, in
  // the same order: an existing Home Assistant or n8n rule parses them.
  // Discord and Slack do not read them. Discord answers 400 "Cannot send an
  // empty message" unless the body carries `content` (or `embeds`), and a
  // Slack incoming webhook needs `text`. Both get the same plain text,
  // built from the already masked title and message, so discreet mode
  // holds. `allowed_mentions` with an empty `parse` stops Discord from
  // resolving `@everyone`, `@here` or `<@id>` that a message might contain.
  // Each target ignores the keys meant for the others.
  const text = [title, message].filter((part) => part.length > 0).join("\n");
  return JSON.stringify({
    title,
    message,
    eventType,
    priority: band,
    content: truncateCodePoints(text, DISCORD_CONTENT_LIMIT),
    text,
    allowed_mentions: { parse: [] },
  });
}

/** Discord rejects a `content` longer than 2000 characters. */
const DISCORD_CONTENT_LIMIT = 2000;

/**
 * Cut `value` to at most `limit` code points, the last one an ellipsis when
 * anything was dropped. Counts code points, not UTF-16 units, so a cut never
 * splits a surrogate pair.
 */
function truncateCodePoints(value: string, limit: number): string {
  const points = Array.from(value);
  if (points.length <= limit) return value;
  return `${points
    .slice(0, limit - 1)
    .join("")
    .trimEnd()}\u2026`;
}

/**
 * Send a notification via a generic outbound webhook (v1.17.1).
 *
 * The user supplies a URL and optionally one custom header, and chooses the
 * body shape: HealthLog's generic JSON envelope (which a Discord or Slack
 * webhook URL also accepts as is), or the body Gotify's
 * `POST /message` binds (see `buildWebhookBody`). Gotify takes its app token
 * as an `X-Gotify-Key` header or a `token` query parameter. The body is plain
 * text (no markdown — hard rule); `title`/`message` are stripped of HTML and
 * decorative emoji on routine reminders exactly like the ntfy sender.
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

    const body = buildWebhookBody(config, payload);

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
    // What the relay said, for the test button (Gotify names the field it
    // could not bind). Refused when it echoes the header or a URL token.
    const upstreamBody = await readUpstreamBody(res, [
      ...secretsInHeaderValue(config.headerValue),
      ...secretsInUrl(config.url),
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
    // A policy refusal is not a network fault: the target is on a private
    // network the operator has not listed. It keeps the soft classification
    // (delivery resumes the moment the origin is listed) but carries its own
    // reason so the ledger and the test button can say why.
    const policyRefused =
      err instanceof SafeFetchError && err.kind === "private_host";
    const reason = policyRefused
      ? "webhook_private_origin_refused"
      : "webhook_network_error";
    const failureCode =
      err instanceof SafeFetchError && !policyRefused
        ? err.kind === "timeout"
          ? "timeout"
          : "connection_failed"
        : undefined;
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
      ...(failureCode ? { failureCode } : {}),
    };
  }
}
