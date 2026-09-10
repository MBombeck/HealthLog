import { z } from "zod/v4";
import { isIP } from "node:net";
import { EVENT_TYPES } from "@/lib/notifications/types";

export const notificationPreferenceSchema = z.object({
  channelId: z.string().min(1),
  eventType: z.enum(EVENT_TYPES),
  enabled: z.boolean(),
});

export const notificationChannelEnabledSchema = z.strictObject({
  enabled: z.boolean(),
});

/**
 * Body of `POST /api/notifications/status` — clear the auto-disable on one of
 * the caller's own channels. The channel is looked up scoped to the session
 * user, so an id alone cannot re-enable somebody else's channel.
 */
export const reEnableChannelSchema = z.object({
  channelId: z.string().min(1).max(64),
});

/**
 * Parse a dotted-quad IPv4 string into normalized octets.
 *
 * Returns null if the input is not exactly four octets, contains non-digit
 * characters, has any octet outside 0–255, or contains leading zeros (which
 * some `parseInt` paths historically allowed — bypassing prefix checks like
 * `h.startsWith("10.")` because "010.x.x.x" still parses to 10).
 */
function parseIpv4Strict(
  host: string,
): [number, number, number, number] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]?|1[0-9]{2}|2[0-4][0-9]|25[0-5])$/.test(part)) {
      return null;
    }
    octets.push(Number(part));
  }
  return [octets[0], octets[1], octets[2], octets[3]];
}

/**
 * Block private/internal network URLs to prevent SSRF. Exported so other
 * server-initiated egress (AI providers, webhooks) can reuse it.
 *
 * Defense layers:
 *  1. Protocol allowlist: only http(s).
 *  2. Pre-URL leading-zero IPv4 check on the *raw* input, because the
 *     `URL` constructor silently normalises "010.0.0.1" to "8.0.0.1"
 *     (octal interpretation) — a real SSRF bypass on naive checks.
 *  3. Hostname denylist for unicast loopback / link-local / metadata services.
 *  4. RFC1918 + CGNAT + 169.254/16 + 127.0.0.0/8 + 0.0.0.0/8 block via
 *     strict IPv4 parser.
 *  5. IPv6 loopback / link-local / unique-local block (brackets-aware).
 *
 * NOTE: This is an *input-time* check on user-supplied URLs. It does not
 * defeat DNS rebinding (where a public hostname later resolves to a private
 * IP). For that, pin the resolved IP at fetch time or use an HTTP client
 * that blocks redirects to private ranges.
 */
function isPrivateIpv4(ip: [number, number, number, number]): boolean {
  const [a, b] = ip;
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 0) return true; // 0.0.0.0/8 reserved (also covers literal 0.0.0.0)
  if (a === 10) return true; // 10.0.0.0/8 RFC1918
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local + AWS metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 RFC1918
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  return false;
}

/**
 * Parse an IPv6 literal into its canonical 16 bytes.
 *
 * Node's `net.isIP` supplies the syntax verdict. The small expansion below is
 * only for policy inspection: comparing normalized bytes avoids the compressed
 * and mixed-spelling bypasses that string-prefix checks cannot cover.
 */
function parseIpv6Bytes(input: string): Uint8Array | null {
  if (isIP(input) !== 6) return null;

  let value = input.toLowerCase();
  const dottedTail = value.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (dottedTail) {
    const ipv4 = parseIpv4Strict(dottedTail);
    if (!ipv4) return null;
    const high = ((ipv4[0] << 8) | ipv4[1]).toString(16);
    const low = ((ipv4[2] << 8) | ipv4[3]).toString(16);
    value = `${value.slice(0, -dottedTail.length)}${high}:${low}`;
  }

  const compressed = value.split("::");
  if (compressed.length > 2) return null;
  const left = compressed[0] ? compressed[0].split(":") : [];
  const right =
    compressed.length === 2 && compressed[1] ? compressed[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (
    missing < 0 ||
    (compressed.length === 1 && missing !== 0) ||
    (compressed.length === 2 && missing < 1)
  ) {
    return null;
  }

  const words = [
    ...left,
    ...Array.from({ length: missing }, () => "0"),
    ...right,
  ].map((word) => Number.parseInt(word, 16));
  if (
    words.length !== 8 ||
    words.some((word) => !Number.isInteger(word) || word < 0 || word > 0xffff)
  ) {
    return null;
  }

  const bytes = new Uint8Array(16);
  words.forEach((word, index) => {
    bytes[index * 2] = word >> 8;
    bytes[index * 2 + 1] = word & 0xff;
  });
  return bytes;
}

function bytesEqual(
  bytes: Uint8Array,
  offset: number,
  expected: readonly number[],
): boolean {
  return expected.every((value, index) => bytes[offset + index] === value);
}

/**
 * Extract the embedded IPv4 address from standard transition formats.
 *
 * The local-use `64:ff9b:1::/48` layout follows the repository's RFC8215
 * fixtures: the first two IPv4 octets occupy bytes 6–7 and the final two
 * occupy bytes 10–11 around the reserved zero field.
 */
function embeddedIpv4(
  bytes: Uint8Array,
): [number, number, number, number] | null {
  const firstTenZero = bytesEqual(bytes, 0, Array(10).fill(0));
  if (firstTenZero && bytes[10] === 0xff && bytes[11] === 0xff) {
    return [bytes[12], bytes[13], bytes[14], bytes[15]];
  }

  if (bytesEqual(bytes, 0, Array(12).fill(0))) {
    return [bytes[12], bytes[13], bytes[14], bytes[15]];
  }

  if (bytes[0] === 0x20 && bytes[1] === 0x02) {
    return [bytes[2], bytes[3], bytes[4], bytes[5]];
  }

  if (
    bytesEqual(bytes, 0, [0x00, 0x64, 0xff, 0x9b]) &&
    bytesEqual(bytes, 4, Array(8).fill(0))
  ) {
    return [bytes[12], bytes[13], bytes[14], bytes[15]];
  }

  if (
    bytesEqual(bytes, 0, [0x00, 0x64, 0xff, 0x9b, 0x00, 0x01]) &&
    bytes[8] === 0 &&
    bytes[9] === 0
  ) {
    return [bytes[6], bytes[7], bytes[10], bytes[11]];
  }

  return null;
}

/**
 * Decide whether a raw IP address string (as returned by `dns.lookup`)
 * points at a public range — i.e. is safe to dial.
 *
 * Used by the pinned dispatcher (issue #217) inside undici's connect
 * hook to defeat DNS rebinding: even when `isPublicUrl` accepted the
 * hostname at input time, the resolver can flip between accept and
 * dispatch. This second check runs against the literal address the
 * connection would target.
 *
 * Accepts:
 *  - dotted-quad IPv4 ("203.0.113.5", "10.0.0.1")
 *  - IPv6 literal ("2001:db8::1", "::1", "fe80::1", "::ffff:127.0.0.1")
 *
 * Rejects every range `isPublicUrl` would reject at input time plus
 * IPv4-mapped IPv6 (resolvers occasionally emit these).
 */
export function isPublicIp(ip: string): boolean {
  if (!ip) return false;
  const lower = ip.toLowerCase();

  const family = isIP(lower);
  if (family === 4) {
    const parsed = parseIpv4Strict(lower);
    if (!parsed) return false;
    return !isPrivateIpv4(parsed);
  }

  if (family === 6) {
    const bytes = parseIpv6Bytes(lower);
    if (!bytes) return false;

    // Unspecified, loopback, link-local, and unique-local IPv6.
    if (bytesEqual(bytes, 0, Array(16).fill(0))) return false;
    if (bytesEqual(bytes, 0, Array(15).fill(0)) && bytes[15] === 1) {
      return false;
    }
    if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return false;
    if ((bytes[0] & 0xfe) === 0xfc) return false;

    const embedded = embeddedIpv4(bytes);
    if (embedded && isPrivateIpv4(embedded)) return false;
    return true;
  }

  // Anything else (non-IP string, malformed) — refuse rather than
  // dispatch.
  return false;
}

/**
 * Decide whether a resolved address may be dialled under an operator's
 * exact-origin grant (`NOTIFICATION_PRIVATE_ORIGINS`,
 * `NIGHTSCOUT_PRIVATE_ORIGINS`).
 *
 * A grant exists so a relay on the operator's own network can be reached, so
 * RFC1918, CGNAT (a Tailscale address) and IPv6 unique-local stay grantable.
 * Four ranges are refused even when the operator lists a name that resolves
 * there, because no notification relay lives on them and each one is a
 * different admin surface: loopback is the app itself inside the container
 * (and on host networking, every admin port of the host), the unspecified
 * address is a resolver misfire, link-local is the cloud-metadata endpoint.
 * The transition formats (`::ffff:`, 6to4, NAT64) are unwrapped first so an
 * IPv6 spelling of loopback does not slip past the IPv4 verdict.
 */
export function isOperatorGrantableIp(ip: string): boolean {
  if (!ip) return false;
  const lower = ip.toLowerCase();

  const family = isIP(lower);
  if (family === 4) {
    const parsed = parseIpv4Strict(lower);
    if (!parsed) return false;
    return !isNeverGrantableIpv4(parsed);
  }

  if (family === 6) {
    const bytes = parseIpv6Bytes(lower);
    if (!bytes) return false;

    // Unspecified, loopback and link-local IPv6. Unique-local (fc00::/7)
    // deliberately stays out of this list: it is the IPv6 analogue of
    // RFC1918 and exactly what an operator lists.
    if (bytesEqual(bytes, 0, Array(16).fill(0))) return false;
    if (bytesEqual(bytes, 0, Array(15).fill(0)) && bytes[15] === 1) {
      return false;
    }
    if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return false;

    const embedded = embeddedIpv4(bytes);
    if (embedded && isNeverGrantableIpv4(embedded)) return false;
    return true;
  }

  return false;
}

/** 127/8, 0/8 and 169.254/16: the ranges no operator grant may open. */
function isNeverGrantableIpv4(ip: [number, number, number, number]): boolean {
  const [a, b] = ip;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

export function isPublicUrl(url: string): boolean {
  try {
    // Pre-URL guard #1: the WHATWG URL parser interprets leading-zero IPv4
    // octets as octal. "010.0.0.1" silently becomes "8.0.0.1" (public),
    // bypassing any post-parse "starts with 10." check.
    const rawHostMatch = url.match(/^[a-z]+:\/\/(?:[^@/]*@)?([^:/?#]+)/i);
    const rawHost = rawHostMatch?.[1] ?? "";
    if (/^\d+\.\d+\.\d+\.\d+$/.test(rawHost)) {
      // Reject any segment with a leading zero (octal-bypass surface).
      if (/(?:^|\.)0\d/.test(rawHost)) return false;
    }

    // Pre-URL guard #2: hex-notation IPv4 ("http://0x7f.0.0.1" or
    // "http://0x7f000001") and decimal-notation IPv4 ("http://2130706433"
    // = 127.0.0.1). The URL parser normalises both into a real IPv4 string
    // — the post-parse path *would* catch them, but only via Node's parser
    // behaviour which has historically been inconsistent. Reject the raw
    // alternate notations outright.
    if (/^0x[0-9a-f]+(?:\.|$)/i.test(rawHost)) return false;
    if (/^\d+$/.test(rawHost) && rawHost.length >= 8) {
      // Pure-decimal IPv4 ("4294967295" max). Only treat as suspicious when
      // the value could plausibly be an IP — short numeric "hostnames"
      // would not parse as URLs anyway.
      return false;
    }

    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return false;
    }
    let h = parsed.hostname.toLowerCase();
    if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);

    // Hostname denylist (literal strings).
    if (
      h === "localhost" ||
      h.endsWith(".internal") ||
      h.endsWith(".local") ||
      h.endsWith(".localhost")
    ) {
      return false;
    }

    // One normalized byte-level verdict for every literal IP. DNS hostnames
    // deliberately fall through to the pinned resolver boundary.
    if (isIP(h) !== 0) return isPublicIp(h);

    return true;
  } catch {
    return false;
  }
}

/**
 * ntfy channel settings. The server URL is user-supplied and must pass the
 * target predicate at input time. The exported constant carries the plain
 * public floor (`isPublicUrl`) for the OpenAPI contract; the save route
 * builds the same shape with `isAllowedNotificationTarget`, which adds the
 * operator's `NOTIFICATION_PRIVATE_ORIGINS` grant (#947) on top of the floor
 * without this module having to read the environment.
 */
export function ntfySettingsSchemaWith(
  isAllowedTarget: (url: string) => boolean,
) {
  return z.object({
    serverUrl: z
      .url("Ungültige Server-URL")
      .max(200)
      .refine(
        isAllowedTarget,
        "Server-URL darf nicht auf interne Netzwerke zeigen",
      )
      .optional()
      .or(z.literal("")),
    topic: z.string().max(100).optional().or(z.literal("")),
    authToken: z.string().max(200).optional().or(z.literal("")),
    enabled: z.boolean(),
  });
}

export const ntfySettingsSchema = ntfySettingsSchemaWith(isPublicUrl);

/**
 * Generic-webhook channel settings (v1.17.1). The URL is user-supplied and
 * must pass the target predicate at input time; the sender re-checks it at
 * fetch time through `safeFetch` with the connect-time pin. The exported
 * constant carries the plain public floor for the OpenAPI contract; the save
 * route passes `isAllowedNotificationTarget` so an origin the operator listed
 * in `NOTIFICATION_PRIVATE_ORIGINS` (#947) saves. The optional header
 * name/value carry a shared secret (e.g. Gotify token).
 */
export function webhookSettingsSchemaWith(
  isAllowedTarget: (url: string) => boolean,
) {
  return z.object({
    url: z
      .url("Ungültige Webhook-URL")
      .max(500)
      .refine(
        isAllowedTarget,
        "Webhook-URL darf nicht auf interne Netzwerke zeigen",
      )
      .optional()
      .or(z.literal("")),
    headerName: z.string().max(100).optional().or(z.literal("")),
    headerValue: z.string().max(500).optional().or(z.literal("")),
    enabled: z.boolean(),
  });
}

export const webhookSettingsSchema = webhookSettingsSchemaWith(isPublicUrl);

/**
 * Email channel settings (v1.17.1). The SMTP transport is operator-configured;
 * the only per-user value is the recipient address.
 */
export const emailSettingsSchema = z.object({
  recipient: z
    .email("Ungültige E-Mail-Adresse")
    .max(254)
    .optional()
    .or(z.literal("")),
  enabled: z.boolean(),
});

export const webPushSubscriptionSchema = z.object({
  endpoint: z
    .url("Ungültiger Endpoint")
    .max(500)
    .refine(
      (url) => url.startsWith("https://"),
      "Endpoint muss HTTPS verwenden",
    )
    .refine(
      (url) => isPublicUrl(url),
      "Endpoint darf nicht auf interne Netzwerke zeigen",
    ),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
});

/**
 * Body of `POST /api/admin/notifications/reminder-check` — the admin panel's
 * manual reminder sweep.
 *
 * `userId` narrows the sweep to one account. Omitted (and a bodyless POST is
 * the admin console's own call) the sweep stays instance-wide, which is what
 * the operator button has always done. The field is an ACCOUNT SELECTOR, not
 * an identity: the route is `requireAdmin()`, cookie-only by construction, so
 * naming an account here can never widen who is allowed to run the sweep — it
 * only narrows whose overdue doses it dispatches for.
 *
 * Strict, so a typo'd key is a 422 rather than a silently instance-wide run.
 */
export const adminReminderCheckSchema = z.strictObject({
  userId: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/, "Ungültige Account-ID")
    .optional(),
});
