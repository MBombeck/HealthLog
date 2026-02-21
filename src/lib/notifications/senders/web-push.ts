import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import type { NotificationPayload } from "@/lib/notifications/types";

/**
 * Send Web Push notification to all subscribed devices of a user.
 * Requires VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT env vars.
 * Returns true if at least one delivery succeeded.
 */
export async function sendViaWebPush(
  userId: string,
  payload: NotificationPayload,
): Promise<boolean> {
  try {
    // Lazy import to avoid issues when web-push is not installed
    const webpush = await import("web-push");

    const vapidPublic = process.env.VAPID_PUBLIC_KEY;
    const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
    const vapidSubject = process.env.VAPID_SUBJECT;

    if (!vapidPublic || !vapidPrivate || !vapidSubject) {
      console.warn("Web Push: VAPID keys not configured");
      return false;
    }

    webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);

    const subscriptions = await prisma.pushSubscription.findMany({
      where: { userId },
    });

    if (!subscriptions.length) return false;

    const pushPayload = JSON.stringify({
      title: payload.title,
      body: payload.message.replace(/<[^>]*>/g, ""),
      tag: payload.eventType,
      url: "/",
    });

    let anySuccess = false;
    const expiredIds: string[] = [];

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
      } catch (err: unknown) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 410 || status === 404) {
          // Subscription expired or invalid — mark for cleanup
          expiredIds.push(sub.id);
        }
      }
    }

    // Clean up expired subscriptions
    if (expiredIds.length > 0) {
      await prisma.pushSubscription.deleteMany({
        where: { id: { in: expiredIds } },
      });
    }

    return anySuccess;
  } catch {
    return false;
  }
}
