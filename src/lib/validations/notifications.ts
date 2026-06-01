import { z } from "zod/v4";
import { EVENT_TYPES } from "@/lib/notifications/types";

export const notificationPreferenceSchema = z.object({
  channelId: z.string().min(1),
  eventType: z.enum(EVENT_TYPES),
  enabled: z.boolean(),
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

  // IPv4 dotted-quad (what dns.lookup with family=4 returns).
  if (/^\d+\.\d+\.\d+\.\d+$/.test(lower)) {
    const parsed = parseIpv4Strict(lower);
    if (!parsed) return false;
    return !isPrivateIpv4(parsed);
  }

  // IPv6. Only strings with a colon make it past the previous check.
  if (lower.includes(":")) {
    if (lower === "::1" || lower === "::") return false;
    if (lower.startsWith("fe80:")) return false;
    if (/^fc[0-9a-f]{0,2}:/.test(lower)) return false;
    if (/^fd[0-9a-f]{0,2}:/.test(lower)) return false;

    // IPv4-mapped IPv6 dotted form ("::ffff:127.0.0.1"). Some resolvers
    // emit this when an AAAA falls through to a synthesized A.
    const mappedDotted = lower.match(/^(?:::ffff:)(\d+\.\d+\.\d+\.\d+)$/);
    if (mappedDotted) {
      const parsed = parseIpv4Strict(mappedDotted[1]);
      if (!parsed || isPrivateIpv4(parsed)) return false;
      return true;
    }

    // IPv4-mapped IPv6 hex pair form ("::ffff:7f00:1").
    const mappedHex = lower.match(
      /^(?:::ffff:)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/,
    );
    if (mappedHex) {
      const high = parseInt(mappedHex[1], 16);
      const low = parseInt(mappedHex[2], 16);
      const parsed: [number, number, number, number] = [
        (high >> 8) & 0xff,
        high & 0xff,
        (low >> 8) & 0xff,
        low & 0xff,
      ];
      if (isPrivateIpv4(parsed)) return false;
      return true;
    }
    return true;
  }

  // Anything else (non-IP string, malformed) — refuse rather than
  // dispatch.
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

    // IPv6 loopback / unspecified / link-local / unique-local. Must be
    // gated on a colon — the previous `startsWith("fc")` falsely blocked
    // any DNS hostname starting with "fc" or "fd" (e.g. fcm.googleapis.com).
    if (h === "::1" || h === "::") {
      return false;
    }
    if (h.includes(":")) {
      if (
        h.startsWith("fe80:") ||
        /^fc[0-9a-f]{0,2}:/.test(h) ||
        /^fd[0-9a-f]{0,2}:/.test(h)
      ) {
        return false;
      }
    }

    // IPv4-mapped IPv6 ("::ffff:127.0.0.1" or "::ffff:7f00:1") and
    // 6to4 / NAT64 with embedded private IPv4. Extract the trailing
    // dotted-quad if present, otherwise extract the last 32 bits as
    // hex pairs and reconstruct.
    if (h.includes(":")) {
      const ipv4MappedDotted = h.match(/^(?:::ffff:)(\d+\.\d+\.\d+\.\d+)$/);
      if (ipv4MappedDotted) {
        const ip = parseIpv4Strict(ipv4MappedDotted[1]);
        if (!ip || isPrivateIpv4(ip)) return false;
      }
      const ipv4MappedHex = h.match(
        /^(?:::ffff:)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/,
      );
      if (ipv4MappedHex) {
        const high = parseInt(ipv4MappedHex[1], 16);
        const low = parseInt(ipv4MappedHex[2], 16);
        const ip: [number, number, number, number] = [
          (high >> 8) & 0xff,
          high & 0xff,
          (low >> 8) & 0xff,
          low & 0xff,
        ];
        if (isPrivateIpv4(ip)) return false;
      }
    }

    // Strict IPv4 parsing: reject malformed forms outright (better a false
    // positive than an SSRF) and apply RFC1918 / CGNAT / loopback bans.
    if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
      const ip = parseIpv4Strict(h);
      if (!ip) return false;
      if (isPrivateIpv4(ip)) return false;
    }

    return true;
  } catch {
    return false;
  }
}

export const ntfySettingsSchema = z.object({
  serverUrl: z
    .url("Ungültige Server-URL")
    .max(200)
    .refine(
      (url) => isPublicUrl(url),
      "Server-URL darf nicht auf interne Netzwerke zeigen",
    )
    .optional()
    .or(z.literal("")),
  topic: z.string().max(100).optional().or(z.literal("")),
  authToken: z.string().max(200).optional().or(z.literal("")),
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
