import { isIP } from "node:net";
import {
  isOperatorGrantableIp,
  isPublicUrl,
} from "@/lib/validations/notifications";

/**
 * Exact-origin grant grammar shared by every operator allowlist that opens a
 * private destination: `NIGHTSCOUT_PRIVATE_ORIGINS` (v1.17.0) and
 * `NOTIFICATION_PRIVATE_ORIGINS` (#947). One parser, one verdict, so the two
 * lists cannot drift in what they accept.
 *
 * A grant is one canonical `scheme://host[:port]` trust unit. It is never a
 * suffix, wildcard, CIDR, capability URL or prefix: a range grant would let a
 * DNS rebinding to any address inside the range pass the connect-time pin,
 * which turns the pin into a formality. An operator with several relays lists
 * several origins.
 */

export const PRIVATE_ORIGIN_NOT_APPROVED =
  "private_origin_not_approved" as const;
export const INVALID_ORIGIN = "invalid_origin" as const;

export type OriginReason =
  typeof PRIVATE_ORIGIN_NOT_APPROVED | typeof INVALID_ORIGIN;

export interface OriginVerdict {
  allowed: boolean;
  canonicalOrigin: string | null;
  privateOriginApproved: boolean;
  reasonCode: OriginReason | null;
}

/**
 * Parse one exact http(s) origin.
 *
 * Credentials, paths, queries, and fragments are deliberately forbidden: the
 * operator grants a complete canonical scheme/host/port trust unit, never a
 * suffix, wildcard, capability URL, or prefix. A literal address in loopback,
 * the unspecified range, link-local or the metadata range is refused too —
 * `isOperatorGrantableIp` says why — and the pinned dispatcher applies the
 * same floor when a listed DNS name resolves there.
 */
export function canonicalOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    if (url.pathname !== "/" || url.search || url.hash) return null;
    if (!url.hostname || url.hostname.includes("*")) return null;
    const literal = url.hostname.replace(/^\[|\]$/g, "");
    if (isIP(literal) !== 0 && !isOperatorGrantableIp(literal)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * The origin of a target URL that may legitimately carry a path (a Gotify
 * `/message` endpoint, an ntfy topic), for comparison against the grant set.
 */
export function originOfUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function sharesApprovedPrivateHostname(
  origin: string,
  privateOrigins: ReadonlySet<string>,
): boolean {
  const hostname = new URL(origin).hostname;

  for (const approvedOrigin of privateOrigins) {
    const approvedHostname = new URL(approvedOrigin).hostname;
    if (
      hostname === approvedHostname ||
      hostname.endsWith(`.${approvedHostname}`)
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Parse a server-only comma-separated exact-origin allowlist.
 *
 * Every malformed non-empty entry is handed to `onInvalid`, which decides the
 * failure mode: the Nightscout list throws (a connection form can afford to
 * fail loudly), the notification list logs once and skips the entry (a typo
 * must not take every public webhook down with it). Either way a malformed
 * entry grants nothing — the set only ever shrinks.
 */
export function parsePrivateOrigins(
  raw: string | undefined,
  onInvalid: (entry: string) => void,
): ReadonlySet<string> {
  const origins = new Set<string>();
  for (const entry of (raw ?? "").split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const origin = canonicalOrigin(trimmed);
    if (!origin) {
      onInvalid(trimmed);
      continue;
    }
    origins.add(origin);
  }
  return origins;
}

/**
 * Resolve one canonical origin against the grant set.
 *
 * Exact operator membership wins before the ordinary public-host verdict so a
 * private DNS name can be trusted without granting its suffix or sibling
 * ports. Public origins remain supported without configuration. `publicCheck`
 * defaults to the origin itself; a caller holding the full URL passes it so
 * the raw-string guards in `isPublicUrl` (octal and hex address spellings)
 * see the text the user typed.
 */
export function evaluateOriginGrant(
  origin: string,
  privateOrigins: ReadonlySet<string>,
  publicCheck: string = origin,
): OriginVerdict {
  if (privateOrigins.has(origin)) {
    return {
      allowed: true,
      canonicalOrigin: origin,
      privateOriginApproved: true,
      reasonCode: null,
    };
  }

  // An exact grant must not accidentally become a hostname suffix grant.
  // Deny related hosts before the generic public-host fallback: private DNS
  // names such as gotify.lan may otherwise look syntactically public here.
  if (sharesApprovedPrivateHostname(origin, privateOrigins)) {
    return {
      allowed: false,
      canonicalOrigin: origin,
      privateOriginApproved: false,
      reasonCode: PRIVATE_ORIGIN_NOT_APPROVED,
    };
  }

  if (isPublicUrl(publicCheck)) {
    return {
      allowed: true,
      canonicalOrigin: origin,
      privateOriginApproved: false,
      reasonCode: null,
    };
  }

  return {
    allowed: false,
    canonicalOrigin: origin,
    privateOriginApproved: false,
    reasonCode: PRIVATE_ORIGIN_NOT_APPROVED,
  };
}
