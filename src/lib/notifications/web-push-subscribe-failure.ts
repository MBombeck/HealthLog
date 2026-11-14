/**
 * Why `pushManager.subscribe()` refused, in the terms the Browser Push card
 * explains to a person.
 *
 * Only the browser's own refusal is classified here. A missing VAPID key and
 * a failed save are server answers and keep their own messages in the card.
 *
 * - `denied`: notifications are blocked for this site
 *   (`Notification.permission === "denied"`), whatever the error said.
 * - `push-service` / `push-service-brave`: the browser could not register
 *   with its push service ("AbortError: Registration failed - push service
 *   error"). The page did nothing wrong and cannot fix it; the browser has to
 *   reach its push service. Brave ships with that switched off, which is the
 *   common case, so Brave gets the setting named.
 * - `unknown`: anything else, which keeps the generic message. That includes
 *   a dismissed permission prompt (`NotAllowedError`, or an `AbortError`
 *   about permission in older Chromium builds): the permission is still
 *   "default", the person can try again, and calling it a push-service fault
 *   would send them to the wrong setting.
 */
export type WebPushSubscribeFailure =
  "denied" | "push-service" | "push-service-brave" | "unknown";

export interface WebPushSubscribeContext {
  /** `Notification.permission` after the attempt. */
  permission: NotificationPermission;
  /** The browser announces itself as Brave (`navigator.brave`). */
  isBrave: boolean;
}

function errorName(error: unknown): string {
  return typeof error === "object" && error !== null && "name" in error
    ? String((error as { name: unknown }).name)
    : "";
}

function errorMessage(error: unknown): string {
  return typeof error === "object" && error !== null && "message" in error
    ? String((error as { message: unknown }).message)
    : "";
}

export function classifyWebPushSubscribeFailure(
  error: unknown,
  { permission, isBrave }: WebPushSubscribeContext,
): WebPushSubscribeFailure {
  const name = errorName(error);
  const message = errorMessage(error);

  if (permission === "denied") return "denied";
  if (name !== "AbortError") return "unknown";
  if (/permission/i.test(message)) return "unknown";
  // A key the server handed out that the browser would not take is the
  // server's problem, not the push service's.
  if (/applicationServerKey/i.test(message)) return "unknown";
  return isBrave ? "push-service-brave" : "push-service";
}

/**
 * Brave exposes `navigator.brave` so a page can tell it apart from Chrome,
 * whose user agent it otherwise copies.
 */
export function isBraveBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  const brave = (navigator as Navigator & { brave?: unknown }).brave;
  return typeof brave === "object" && brave !== null;
}
