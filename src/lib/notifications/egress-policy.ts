import {
  evaluateOriginGrant,
  INVALID_ORIGIN,
  originOfUrl,
  parsePrivateOrigins,
  PRIVATE_ORIGIN_NOT_APPROVED,
  type OriginVerdict,
} from "@/lib/private-origin-policy";
import { annotate } from "@/lib/logging/context";

/**
 * `NOTIFICATION_PRIVATE_ORIGINS` (#947) — the operator grant that lets the
 * generic webhook and ntfy senders reach a relay on the operator's own
 * network (a Gotify behind a LAN reverse proxy, a self-hosted ntfy on
 * Tailscale).
 *
 * Both senders dial through `safeFetch` with the connect-time DNS pin, which
 * refuses any destination that resolves to a private address. That is the
 * DNS-rebinding defence (#217) and it is deliberate: a public-looking name
 * with a LAN A record is exactly what it stops. The grant is the operator's
 * way to say "this one origin is mine": comma-separated exact origins,
 *
 *   NOTIFICATION_PRIVATE_ORIGINS="https://gotify.example.com,http://ntfy.lan:8080"
 *
 * A listed origin is still dialled through the pinned resolver with redirects
 * forbidden; loopback, link-local and the metadata range stay refused even
 * when listed. Nothing not listed widens, and there is no `=true`, CIDR,
 * wildcard or suffix form. The grant lives in the server environment only —
 * no request field and no settings toggle can confer it.
 *
 * The variable is read directly from `process.env` so the compose-whitelist
 * guard sees the read. It is parsed once per distinct value: a malformed
 * entry is logged once and grants nothing, and the valid entries beside it
 * keep working, because a typo in one relay's origin must not take every
 * public webhook on the instance down with it.
 */

const ENV_NAME = "NOTIFICATION_PRIVATE_ORIGINS";

let cachedRaw: string | undefined;
let cachedOrigins: ReadonlySet<string> = new Set();

export function configuredNotificationPrivateOrigins(): ReadonlySet<string> {
  const raw = process.env.NOTIFICATION_PRIVATE_ORIGINS;
  if (raw === cachedRaw) return cachedOrigins;
  cachedOrigins = parsePrivateOrigins(raw, (entry) => {
    console.warn(
      `${ENV_NAME}: ignoring entry "${entry}" — a grant is one exact http(s) origin (scheme://host[:port]) on a private network; loopback, link-local and metadata addresses cannot be granted`,
    );
  });
  cachedRaw = raw;
  return cachedOrigins;
}

/**
 * Resolve one webhook or ntfy target URL against the grant and the public
 * floor. The target may carry a path (Gotify's `/message`, an ntfy topic);
 * only its origin is compared to the grant set. The full URL goes to the
 * public check so the raw-string guards in `isPublicUrl` (octal and hex
 * address spellings) see what the user typed.
 *
 * One function for every caller — the settings save, the test button and the
 * dispatcher's senders — so the decision cannot differ between the button
 * that says "works" and the reminder that then does not arrive.
 */
export function evaluateNotificationTarget(url: string): OriginVerdict {
  const origin = originOfUrl(url);
  if (!origin) {
    return {
      allowed: false,
      canonicalOrigin: null,
      privateOriginApproved: false,
      reasonCode: INVALID_ORIGIN,
    };
  }
  return evaluateOriginGrant(
    origin,
    configuredNotificationPrivateOrigins(),
    url,
  );
}

/** Predicate form for the Zod refine on the save routes. */
export function isAllowedNotificationTarget(url: string): boolean {
  return evaluateNotificationTarget(url).allowed;
}

export { PRIVATE_ORIGIN_NOT_APPROVED };

/**
 * Wide-event mark for a send that used the grant: one row per private
 * egress, pinned to `{ channel, origin }` so a dashboard can count them and
 * an operator can see which grant is actually in use. The origin is the
 * canonical grant string, never the full target URL, which may carry a
 * token in its path or query.
 */
export function annotatePrivateOriginEgress(
  channel: "webhook" | "ntfy",
  origin: string,
): void {
  annotate({
    action: { name: "notification.egress.private_origin" },
    meta: { channel, origin },
  });
}
