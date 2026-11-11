import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import type { NotificationPayload } from "@/lib/notifications/types";
import type { SendOutcome } from "@/lib/notifications/retry-policy";
import { classifyHttpStatus } from "@/lib/notifications/retry-policy";
import { getVapidConfig } from "@/lib/notifications/vapid-config";
import { getEvent } from "@/lib/logging/context";
import { recordPushAttemptForPayload } from "@/lib/notifications/senders/push-attempt-record";
import { isPublicUrl } from "@/lib/validations/notifications";
import { safeFetch } from "@/lib/safe-fetch";
import { plainPushText } from "@/lib/notifications/strip-emoji";
import { stripHtml } from "@/lib/notifications/strip-html";
import { isManagedGuardianDelivery } from "@/lib/notifications/managed-delivery";
import { isSafeAppPath } from "@/lib/notifications/tap-target";

/**
 * Send Web Push notification to all subscribed devices of a user.
 * VAPID config is loaded from app settings first, then env as fallback.
 *
 * Returns a structured `SendOutcome` (v1.4.15 Phase B3) so the dispatcher
 * can classify the channel state:
 *  - `ok: true`  if at least one device received the push.
 *  - `hardReject: true` only when ALL surviving subscriptions returned a
 *    permanent reject (410/404) and the channel can no longer succeed.
 *    The 410 subscriptions themselves are deleted from the DB regardless,
 *    so a hard-channel-reject means the user has zero devices left.
 *  - `hardReject: false` for any 5xx, 429 or fetch failure.
 *  - `reason: "web_push_no_subscriptions"` (or `_vapid_not_configured`) when
 *    there is nothing to send to; the dispatcher leaves the channel state
 *    alone for those.
 */
export async function sendViaWebPush(
  userId: string,
  payload: NotificationPayload,
): Promise<SendOutcome> {
  try {
    const managedDelivery = isManagedGuardianDelivery(payload);
    // Lazy import to avoid issues when web-push is not installed
    const webpush = await import("web-push");

    const config = await getVapidConfig();
    if (!config) {
      getEvent()?.addWarning("Web Push: VAPID keys not configured");
      recordPushAttemptForPayload(payload, userId, {
        userId,
        channel: "WEB_PUSH",
        eventType: payload.eventType,
        result: "skipped",
        reason: "web_push_vapid_not_configured",
      });
      return {
        ok: false,
        hardReject: false,
        reason: "web_push_vapid_not_configured",
      };
    }

    webpush.setVapidDetails(
      config.subject,
      config.publicKey,
      config.privateKey,
    );

    const subscriptions = await prisma.pushSubscription.findMany({
      where: { userId },
    });

    if (!subscriptions.length) {
      // No browser subscribed (never, or push was turned off on the last
      // one). Nothing failed; the dispatcher books this as a skip.
      recordPushAttemptForPayload(payload, userId, {
        userId,
        channel: "WEB_PUSH",
        eventType: payload.eventType,
        result: "skipped",
        reason: "web_push_no_subscriptions",
      });
      return {
        ok: false,
        hardReject: false,
        reason: "web_push_no_subscriptions",
      };
    }

    // v1.18.4 — a dispatcher payload may carry a stable per-slot tag in
    // `metadata.webPushTag` (e.g. a medication dose slot, see
    // `medicationDoseTag`). The matching `type:"clear"` push reuses the SAME
    // tag so the SW can replace/close the pending reminder when the dose is
    // logged — the PWA-only equivalent of ending a Live Activity. Discreet
    // mode still wins so no event name leaks even when a stable tag exists.
    const stableTag =
      typeof payload.metadata?.webPushTag === "string"
        ? payload.metadata.webPushTag
        : undefined;
    // v1.18.4 — server-authoritative app-badge count. The dispatcher puts the
    // user's current outstanding-dose count in `metadata.badgeCount`; the SW
    // calls `navigator.setAppBadge(count)` (feature-detected, no-op elsewhere).
    const badgeCount =
      typeof payload.metadata?.badgeCount === "number" &&
      Number.isFinite(payload.metadata.badgeCount)
        ? Math.max(0, Math.trunc(payload.metadata.badgeCount))
        : undefined;

    const pushPayload = JSON.stringify({
      title: plainPushText(payload.title, payload.eventType),
      body: plainPushText(stripHtml(payload.message), payload.eventType),
      // Discreet mode (cycle privacy): the coalescing `tag` must not name the
      // event. Web-Push payloads are VAPID-encrypted (only the SW sees this),
      // but the discreet contract still requires no event name on the wire —
      // mirror the APNs GENERIC_EVENT collapse (QA M-sec3).
      tag: payload.discreet ? "REMINDER" : (stableTag ?? payload.eventType),
      ...(badgeCount !== undefined ? { badge: badgeCount } : {}),
      // v1.15.20 — opt-in deep link: a dispatcher payload may carry a
      // same-origin path in `metadata.url` (e.g. the Coach nudge's
      // `/coach`); everything else keeps the legacy "/" click
      // target. Only relative paths are honoured so a poisoned metadata
      // value can never point the SW at a foreign origin.
      // The dispatcher's resolved tap target (`tap-target.ts`) wins; a payload
      // that did not pass through the dispatcher keeps the metadata path.
      url: managedDelivery
        ? "/"
        : (payload.tap?.path ??
          (isSafeAppPath(payload.metadata?.url) ? payload.metadata.url : "/")),
      // v1.18.4 — urgent events ask the service worker to keep the
      // notification on screen until the user acts on it (where the
      // browser honours `requireInteraction`).
      requireInteraction: payload.urgent === true,
    });

    // v1.18.4 — the Web Push `Urgency` header (RFC 8030) tells the push
    // service to deliver immediately rather than batching for power. An
    // urgent event uses `high`; everything else keeps the library default.
    const sendOptions =
      payload.urgent === true
        ? ({ urgency: "high" as const } as const)
        : undefined;

    let anySuccess = false;
    const expiredIds: string[] = [];
    let lastTransientStatus: number | undefined;
    let allPermanentReject = true;
    const pushStart = performance.now();

    for (const sub of subscriptions) {
      try {
        // Egress-time SSRF floor: `web-push` dials this endpoint with its own
        // internal fetch (no safeFetch). The subscribe route already rejects
        // non-public endpoints, but re-check here to cover any row stored
        // before that guard landed. A non-public endpoint is dropped, never
        // dialled — treat like an expired subscription.
        if (!isPublicUrl(sub.endpoint)) {
          expiredIds.push(sub.id);
          continue;
        }

        const p256dh = decrypt(sub.p256dh);
        const auth = decrypt(sub.auth);

        // The dial itself goes through `safeFetch` with `requirePublicHost`,
        // not through `web-push`'s own internal `https.request`. The literal
        // `isPublicUrl` check above is an input-time floor and cannot see a
        // DNS rebind between the check and the connect; the pinned dispatcher
        // vets every address the resolver actually returns (issue #217).
        // `generateRequestDetails` performs the identical VAPID signing and
        // payload encryption `sendNotification` would have — only the
        // transport changes.
        const details = webpush.generateRequestDetails(
          {
            endpoint: sub.endpoint,
            keys: { p256dh, auth },
          },
          pushPayload,
          sendOptions,
        ) as {
          endpoint: string;
          method: string;
          headers: Record<string, string>;
          body: Buffer | string | null;
        };

        const pushRes = await safeFetch(
          details.endpoint,
          {
            method: details.method,
            headers: details.headers,
            // `generateRequestDetails` hands back a Node Buffer for an
            // encrypted payload; widen it to the BodyInit the fetch API takes.
            body: (details.body ?? undefined) as BodyInit | undefined,
          },
          { requirePublicHost: true },
        );

        if (pushRes.status < 200 || pushRes.status >= 300) {
          // Re-shape as the `{ statusCode }` rejection the classification
          // below already understands, so the 410/404 expiry path and the
          // transient/permanent split stay byte-for-byte unchanged.
          throw Object.assign(
            new Error(`Web Push responded ${pushRes.status}`),
            { statusCode: pushRes.status },
          );
        }
        anySuccess = true;
        allPermanentReject = false;
      } catch (err: unknown) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 410 || status === 404) {
          // Subscription expired or invalid — mark for cleanup, but
          // don't flip the whole channel hard until we know NO sub
          // succeeded.
          expiredIds.push(sub.id);
        } else {
          // Soft failure on at least one sub — channel is alive enough
          // that we shouldn't auto-disable on this dispatch.
          allPermanentReject = false;
          lastTransientStatus = status;
        }
      }
    }

    getEvent()?.addExternalCall({
      service: "web-push",
      method: "sendNotification",
      duration_ms: Math.round(performance.now() - pushStart),
      error: anySuccess ? undefined : "all_failed",
    });

    // Clean up expired subscriptions
    if (expiredIds.length > 0) {
      await prisma.pushSubscription.deleteMany({
        where: { id: { in: expiredIds } },
      });
    }

    if (anySuccess) {
      recordPushAttemptForPayload(payload, userId, {
        userId,
        channel: "WEB_PUSH",
        eventType: payload.eventType,
        result: "ok",
      });
      return { ok: true };
    }

    // Every sub returned a permanent 410/404 → channel is dead until
    // the user re-pairs a device. This is a hard reject.
    if (allPermanentReject && expiredIds.length === subscriptions.length) {
      recordPushAttemptForPayload(payload, userId, {
        userId,
        channel: "WEB_PUSH",
        eventType: payload.eventType,
        result: "error",
        reason: "web_push_410_gone",
      });
      return {
        ok: false,
        hardReject: true,
        statusCode: 410,
        reason: "web_push_410_gone",
      };
    }

    // Soft failure (5xx / 429 / fetch error) on at least one sub.
    const classified = classifyHttpStatus(lastTransientStatus, "web-push");
    recordPushAttemptForPayload(payload, userId, {
      userId,
      channel: "WEB_PUSH",
      eventType: payload.eventType,
      result: "error",
      reason: classified.reason,
    });
    return {
      ok: false,
      hardReject: false,
      statusCode: lastTransientStatus,
      reason: classified.reason,
    };
  } catch (err) {
    getEvent()?.setError(
      err instanceof Error
        ? err
        : new Error("[web-push] sendViaWebPush failed"),
    );
    recordPushAttemptForPayload(payload, userId, {
      userId,
      channel: "WEB_PUSH",
      eventType: payload.eventType,
      result: "error",
      reason: "web_push_unexpected_error",
    });
    return {
      ok: false,
      hardReject: false,
      reason: "web_push_unexpected_error",
      message: err instanceof Error ? err.message : "unknown",
    };
  }
}
