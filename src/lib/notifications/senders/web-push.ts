import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import type { NotificationPayload } from "@/lib/notifications/types";
import type { SendOutcome } from "@/lib/notifications/retry-policy";
import { classifyHttpStatus } from "@/lib/notifications/retry-policy";
import { getVapidConfig } from "@/lib/notifications/vapid-config";
import { getEvent } from "@/lib/logging/context";
import { recordPushAttempt } from "@/lib/notifications/senders/push-attempt-record";

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
 *  - `hardReject: false` for any 5xx, 429, fetch failure, or
 *    "no subscriptions at all" (treated as soft so the user can re-pair
 *    a device without the channel staying auto-disabled forever).
 */
export async function sendViaWebPush(
  userId: string,
  payload: NotificationPayload,
): Promise<SendOutcome> {
  try {
    // Lazy import to avoid issues when web-push is not installed
    const webpush = await import("web-push");

    const config = await getVapidConfig();
    if (!config) {
      getEvent()?.addWarning("Web Push: VAPID keys not configured");
      recordPushAttempt({
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
      // No devices registered yet — not a hard channel reject. The user
      // may simply not have hit "Subscribe" on this browser. Counting
      // this as a give-up signal would lock the user out of the channel
      // they just configured. Treat it as a soft "no recipient" instead.
      recordPushAttempt({
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

    const pushPayload = JSON.stringify({
      title: payload.title,
      body: payload.message.replace(/<[^>]*>/g, ""),
      tag: payload.eventType,
      url: "/",
    });

    let anySuccess = false;
    const expiredIds: string[] = [];
    let lastTransientStatus: number | undefined;
    let allPermanentReject = true;
    const pushStart = performance.now();

    for (const sub of subscriptions) {
      try {
        const p256dh = decrypt(sub.p256dh);
        const auth = decrypt(sub.auth);

        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh, auth },
          },
          pushPayload,
        );
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
      recordPushAttempt({
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
      recordPushAttempt({
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
    recordPushAttempt({
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
    recordPushAttempt({
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
