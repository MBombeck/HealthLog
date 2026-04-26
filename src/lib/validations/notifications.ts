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
function parseIpv4Strict(host: string): [number, number, number, number] | null {
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
 *  2. Hostname denylist for unicast loopback / link-local / metadata services.
 *  3. RFC1918 + CGNAT + 169.254/16 block via strict IPv4 parser
 *     (rejects leading zeros so "010.0.0.1" cannot bypass the "10." check).
 *  4. IPv6 loopback / link-local block.
 *
 * NOTE: This is an *input-time* check on user-supplied URLs. It does not
 * defeat DNS rebinding (where a public hostname later resolves to a private
 * IP). For that, pin the resolved IP at fetch time or use an HTTP client
 * that blocks redirects to private ranges.
 */
export function isPublicUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return false;
    }
    const h = parsed.hostname.toLowerCase();

    // Hostname denylist (literal strings — no IP parsing involved).
    if (
      h === "localhost" ||
      h.endsWith(".internal") ||
      h.endsWith(".local") ||
      h.endsWith(".localhost")
    ) {
      return false;
    }

    // IPv6 loopback / link-local / unique-local. URL.hostname strips brackets.
    if (h === "::1" || h === "[::1]" || h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd")) {
      return false;
    }

    // Strict IPv4 parsing — rejects leading-zero forms like "010.0.0.1".
    const ip = parseIpv4Strict(h);
    if (ip) {
      const [a, b] = ip;
      if (a === 127) return false; // 127.0.0.0/8 loopback
      if (a === 0) return false; // 0.0.0.0/8 reserved
      if (a === 10) return false; // 10.0.0.0/8 RFC1918
      if (a === 169 && b === 254) return false; // 169.254.0.0/16 link-local + AWS metadata
      if (a === 172 && b >= 16 && b <= 31) return false; // 172.16.0.0/12 RFC1918
      if (a === 192 && b === 168) return false; // 192.168.0.0/16 RFC1918
      if (a === 100 && b >= 64 && b <= 127) return false; // 100.64.0.0/10 CGNAT
      // Any other valid IPv4 is treated as public.
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
    .refine((url) => isPublicUrl(url), "Server-URL darf nicht auf interne Netzwerke zeigen")
    .optional()
    .or(z.literal("")),
  topic: z.string().max(100).optional().or(z.literal("")),
  authToken: z.string().max(200).optional().or(z.literal("")),
  enabled: z.boolean(),
});

export const webPushSubscriptionSchema = z.object({
  endpoint: z.url("Ungültiger Endpoint"),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
});
