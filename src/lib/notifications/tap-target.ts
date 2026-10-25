/**
 * Where a notification takes the user when they tap it.
 *
 * One map, one resolver. Every event type names the in-app path it opens;
 * the dispatcher resolves the path once per delivery and every channel
 * carries the same target in its own vocabulary:
 *
 *  - ntfy     → `click` in the JSON publish body (absolute URL)
 *  - Telegram → an inline URL button (absolute `https` URL only, see
 *               `telegramLinkMode`)
 *  - Web Push → `url` in the service-worker payload (same-origin path)
 *  - APNs     → `url` in the custom payload (same-origin path)
 *  - Webhook  → `url` in the body (absolute URL)
 *  - Email    → a link line under the body (absolute URL)
 *
 * The map is typed `Record<EventType, …>`, so a new event type without a
 * target does not compile, and `tap-target.test.ts` walks `EVENT_TYPES` so a
 * target that stops resolving fails there too.
 *
 * A producer may name a more precise path in `metadata.url` (the low-stock
 * alert opens the medication's stock tab, the Coach nudge opens its own
 * conversation). That override is accepted only as a same-origin path, so a
 * value that names another host can never become a click target.
 */
import type { EventType, NotificationPayload } from "@/lib/notifications/types";
import { isManagedGuardianDelivery } from "@/lib/notifications/managed-delivery";

/**
 * The default in-app path per event type. `null` means the event is never
 * shown to the user (a silent background push), so it carries no target.
 */
export const NOTIFICATION_TAP_PATHS: Record<EventType, string | null> = {
  MEDICATION_REMINDER: "/medications",
  MEASUREMENT_ANOMALY: "/measurements",
  COMPLIANCE_LOW: "/insights/medications",
  WITHINGS_SYNC_FAILED: "/settings/integrations",
  SYSTEM_ALERT: "/",
  PERSONAL_RECORD: "/achievements",
  // `?add=1` opens the mood entry sheet on the first paint, and only in the
  // recipient's own record: a session switched into another record opens the
  // page without the sheet (`src/app/mood/page-client.tsx`). No other target
  // here opens a write form.
  MOOD_REMINDER: "/mood?add=1",
  CYCLE_PERIOD_SOON: "/cycle",
  CYCLE_PERIOD_CONFIRM: "/cycle",
  CYCLE_FERTILE_SOON: "/cycle",
  COACH_NUDGE: "/coach",
  MEDICATION_LOW_STOCK: "/medications",
  MEASUREMENT_REMINDER: "/checkups",
  MEDICATION_INTAKE_SYNC: null,
  SECURITY_ALERT: "/settings/security",
  DAILY_BRIEFING: "/",
  SHARED_RECORD_INTAKE: "/medications",
  BACKUP_HEALTH: "/admin/backups",
};

const MAX_PATH_LENGTH = 512;

/**
 * A same-origin, absolute-path reference: one leading slash, no scheme, no
 * protocol-relative `//host`, no backslash (browsers normalise `/\host` to
 * `//host`), no whitespace or control characters.
 */
export function isSafeAppPath(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > MAX_PATH_LENGTH) return false;
  if (!value.startsWith("/")) return false;
  if (value.startsWith("//")) return false;
  if (value.includes("\\")) return false;
  if (/[\s\u0000-\u001f\u007f]/.test(value)) return false;
  return true;
}

/**
 * The app root: where a delivery that may not name its event leads.
 */
export const NEUTRAL_TAP_PATH = "/";

/**
 * The path a delivery opens, or `null` when it carries none.
 *
 * Every visible delivery carries one (v1.43); only a silent background push
 * (`null` in {@link NOTIFICATION_TAP_PATHS}) does not. Two deliveries get the
 * app root instead of their event's path:
 *
 * - A Guardian receiving a managed-record notification: their session opens
 *   on their own record, and a path into the managed record's surfaces would
 *   land them on the wrong person. The app root is where the record switcher
 *   lives.
 * - Discreet mode (cycle privacy): the event's path names the surface
 *   (`/cycle`), and discreet mode promises that nothing on the wire names the
 *   event. The root names nothing.
 */
export function resolveTapPath(
  payload: Pick<
    NotificationPayload,
    "eventType" | "metadata" | "discreet" | "recordUserId" | "recipientUserId"
  >,
): string | null {
  const fallback = NOTIFICATION_TAP_PATHS[payload.eventType];
  if (fallback === null || fallback === undefined) return null;
  if (isManagedGuardianDelivery(payload)) return NEUTRAL_TAP_PATH;
  if (payload.discreet) return NEUTRAL_TAP_PATH;
  const override = payload.metadata?.url;
  return isSafeAppPath(override) ? override : fallback;
}

/**
 * The operator-configured public origin (`APP_URL`, then
 * `NEXT_PUBLIC_APP_URL`), the same precedence the invite and handover links
 * use. Env only: a notification is sent from a worker with no request, and
 * the `Host` header is never trusted for a link that leaves the server.
 */
export function configuredAppOrigin(): string | null {
  for (const value of [process.env.APP_URL, process.env.NEXT_PUBLIC_APP_URL]) {
    const trimmed = value?.trim();
    if (!trimmed) continue;
    try {
      const url = new URL(trimmed);
      if (url.protocol !== "https:" && url.protocol !== "http:") continue;
      return url.origin;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/** Absolute URL for a path, or `null` when no public origin is configured. */
export function absoluteAppUrl(
  path: string | null,
  origin: string | null = configuredAppOrigin(),
): string | null {
  if (!path || !origin) return null;
  return `${origin}${path}`;
}

/**
 * How Telegram may carry a link.
 *
 * Telegram refuses an inline URL button whose URL is not `https` or whose
 * host is `localhost` (the whole `sendMessage` fails with "BUTTON_URL_INVALID"),
 * so the button is offered only for a public `https` origin. A plain-HTTP
 * self-host still gets a text link under the message; a loopback origin gets
 * nothing, because no phone can open it.
 */
export function telegramLinkMode(url: string): "button" | "text" | "none" {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "none";
  }
  const host = parsed.hostname.toLowerCase();
  const loopback =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    host === "::1" ||
    /^127\./.test(host) ||
    host === "0.0.0.0";
  if (loopback) return "none";
  if (parsed.protocol === "https:") return "button";
  if (parsed.protocol === "http:") return "text";
  return "none";
}
