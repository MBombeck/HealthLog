import { apiFetchRaw } from "@/lib/api/api-fetch";

/**
 * Remove this browser's Web Push subscription: the server row first, while
 * the session can still name it, then the browser's own. Does nothing when
 * the browser has none.
 *
 * Used by "Disable push" and by sign-out. A subscription left behind at
 * sign-out keeps showing that account's reminders on this browser, to
 * whoever uses it next.
 */
export async function unsubscribeWebPush(): Promise<void> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
  const registration = await navigator.serviceWorker.getRegistration("/sw.js");
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return;
  await apiFetchRaw("/api/notifications/web-push", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint: subscription.endpoint }),
  });
  await subscription.unsubscribe();
}
