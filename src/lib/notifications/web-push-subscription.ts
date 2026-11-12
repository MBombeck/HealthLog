import { apiFetchRaw } from "@/lib/api/api-fetch";

/** This browser's push subscription, or null when it has none. */
async function browserSubscription(): Promise<PushSubscription | null> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    return null;
  }
  const registration = await navigator.serviceWorker.getRegistration("/sw.js");
  return (await registration?.pushManager.getSubscription()) ?? null;
}

function deleteServerRow(subscription: PushSubscription): Promise<Response> {
  return apiFetchRaw("/api/notifications/web-push", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint: subscription.endpoint }),
  });
}

/**
 * Store this browser's subscription for the signed-in account. Also run for a
 * subscription the browser already holds, so a row the server lost comes
 * back and a channel switched off by failed sends is turned on again.
 */
export function saveWebPushSubscription(
  subscription: PushSubscription,
): Promise<Response> {
  const subJson = subscription.toJSON();
  return apiFetchRaw("/api/notifications/web-push", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      endpoint: subJson.endpoint,
      keys: {
        p256dh: subJson.keys?.p256dh ?? "",
        auth: subJson.keys?.auth ?? "",
      },
    }),
  });
}

/**
 * "Disable push": remove the server row, then the browser's own
 * subscription. Does nothing when the browser has none.
 */
export async function unsubscribeWebPush(): Promise<void> {
  const subscription = await browserSubscription();
  if (!subscription) return;
  await deleteServerRow(subscription);
  await subscription.unsubscribe();
}

/**
 * Run a sign-out with this browser's push subscription taken off the account.
 * A subscription left behind keeps showing that account's reminders on this
 * browser, to whoever uses it next.
 *
 * The server row goes first, while the session can still name it; the
 * browser's subscription only once `signOut` resolved. A refused sign-out
 * stores the row again, so the person who is still signed in keeps push.
 * Failures around the subscription never block the sign-out.
 */
export async function signOutWithoutWebPush(
  signOut: () => Promise<unknown>,
): Promise<void> {
  const subscription = await browserSubscription().catch(() => null);
  if (subscription) await deleteServerRow(subscription).catch(() => null);
  try {
    await signOut();
  } catch (failure) {
    if (subscription) {
      await saveWebPushSubscription(subscription).catch(() => null);
    }
    throw failure;
  }
  await subscription?.unsubscribe().catch(() => false);
}
