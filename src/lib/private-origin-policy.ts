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

export const PRIVATE_ORIGIN_NOT_APPROVED_CODE =
  "private_origin_not_approved" as const;
/**
 * The target is loopback, unspecified, link-local or the metadata range: no
 * grant can ever open it, so telling the user to ask the operator would send
 * them in a circle. On host networking the LAN address is the answer.
 */
export const PRIVATE_ORIGIN_NOT_GRANTABLE_CODE =
  "private_origin_not_grantable" as const;
export const INVALID_ORIGIN = "invalid_origin" as const;

export type OriginReason =
  | typeof PRIVATE_ORIGIN_NOT_APPROVED_CODE
  | typeof PRIVATE_ORIGIN_NOT_GRANTABLE_CODE
  | typeof INVALID_ORIGIN;

/**
 * A hostname no grant may name: `localhost` / `*.localhost` (loopback by
 * definition, RFC 6761) or a literal address outside the grantable ranges.
 * DNS names are not judged here — a name that resolves into those ranges is
 * dropped at dial time by the pinned dispatcher.
 */
export function isNeverGrantableHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost")) return true;
  const literal = lower.replace(/^\[|\]$/g, "");
  return isIP(literal) !== 0 && !isOperatorGrantableIp(literal);
}

/**
 * The entry as it may be logged or put in an error message: scheme and host
 * only. A malformed entry is malformed precisely when it carries the shapes
 * that hold a secret — a query with a token, userinfo, a capability URL
 * pasted whole — and this text goes to stdout, not through the wide-event
 * redactors.
 */
export function redactGrantEntry(entry: string): string {
  return entry
    .split(/[?#]/, 1)[0]
    .replace(/\/\/[^/@]*@/, "//")
    .slice(0, 200);
}

/** Why an entry is not a grant, in operator-readable words. */
export function describeGrantRejection(entry: string): string {
  try {
    const url = new URL(entry);
    if (
      (url.protocol === "http:" || url.protocol === "https:") &&
      isNeverGrantableHost(url.hostname)
    ) {
      return "loopback, link-local and metadata addresses cannot be granted; on host networking list the LAN address of the relay instead";
    }
  } catch {
    // fall through to the grammar sentence
  }
  return "a grant is one exact http(s) origin (scheme://host[:port]) with no path, query, credentials or wildcard";
}

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
    // Loopback, unspecified, link-local and metadata literals, and
    // `localhost` / `*.localhost`, are refused at parse time. Other
    // reserved-looking names (`.local` mDNS, `.internal`, `.lan`) stay
    // grantable: an explicitly listed origin is what the list is for, and
    // the dial-time floor still drops a loopback or metadata answer.
    if (isNeverGrantableHost(url.hostname)) return null;
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
 * Every malformed non-empty entry is handed to `onInvalid` with the entry
 * already reduced to scheme and host (`redactGrantEntry`) and the reason in
 * words (`describeGrantRejection`); the callback decides the failure mode: the Nightscout list throws (a connection form can afford to
 * fail loudly), the notification list logs once and skips the entry (a typo
 * must not take every public webhook down with it). Either way a malformed
 * entry grants nothing — the set only ever shrinks.
 */
export function parsePrivateOrigins(
  raw: string | undefined,
  onInvalid: (redactedEntry: string, reason: string) => void,
): ReadonlySet<string> {
  const origins = new Set<string>();
  for (const entry of (raw ?? "").split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const origin = canonicalOrigin(trimmed);
    if (!origin) {
      onInvalid(redactGrantEntry(trimmed), describeGrantRejection(trimmed));
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
      reasonCode: PRIVATE_ORIGIN_NOT_APPROVED_CODE,
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

  // Two refusals that read differently to the person who gets them: a
  // private address the operator could list, and one no grant can open.
  return {
    allowed: false,
    canonicalOrigin: origin,
    privateOriginApproved: false,
    reasonCode: isNeverGrantableHost(new URL(origin).hostname)
      ? PRIVATE_ORIGIN_NOT_GRANTABLE_CODE
      : PRIVATE_ORIGIN_NOT_APPROVED_CODE,
  };
}
