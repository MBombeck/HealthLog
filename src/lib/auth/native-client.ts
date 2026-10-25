/**
 * Native-client detection + token-policy resolver for v1.4 G4.
 *
 * Web browsers (User-Agent contains "Mozilla/") receive a 90-day Bearer
 * token (the legacy behaviour). Native callers (iOS, iPadOS, n8n,
 * Health-Connect, or any unrecognised UA) receive a short-lived 24-hour
 * access token plus a rotating refresh token.
 *
 * UA spoofing risk: this is a defence-in-depth measure, not a security
 * boundary — every issued token is still bound to the authenticated user
 * via `createSession`. A web client that pretends to be native gets a
 * shorter-lived token; that's strictly safer. A native client that
 * pretends to be web only hurts itself (90d token without refresh).
 *
 * Explicit overrides:
 *   - `X-Client-Type: native` always forces native policy.
 *   - `X-Client-Type: web`    always forces web policy.
 */
import { cookieHeaderCarriesSession } from "./session-cookie";

export type ClientPolicy = "web" | "native";

/**
 * Native refresh-token lifetime in days. The single source of truth for
 * the native refresh window — the token policy, the `/api/auth/refresh`
 * fallback, the sync delta-feed window surfaced in `/api/sync/state`, and
 * the tombstone-retention cleanup job all read this so the four never
 * drift. iOS derives its incremental-delta window from the issued
 * `refreshTokenExpiresAt` rather than hardcoding 60 (v1.7.0 iOS-coord
 * §7.2); keep this coupled.
 */
export const NATIVE_REFRESH_TOKEN_DAYS = 60;

/**
 * Tombstone retention margin (days) added on top of the refresh-token
 * lifetime. A device offline longer than the refresh lifetime has lost
 * its token and re-pairs (backfill, not delta), so tombstones only need
 * to outlive the refresh window plus slack. Drives the cleanup job and
 * the `cursorExpired` horizon in `/api/sync/changes`.
 */
export const TOMBSTONE_RETENTION_MARGIN_DAYS = 15;

/** Days a soft-delete tombstone is retained before pruning. */
export const TOMBSTONE_RETENTION_DAYS =
  NATIVE_REFRESH_TOKEN_DAYS + TOMBSTONE_RETENTION_MARGIN_DAYS;

export interface TokenPolicyDecision {
  policy: ClientPolicy;
  /** Lifetime of the issued ApiToken in days. */
  accessTokenDays: number;
  /** Lifetime of the rotating refresh token in days (null for web). */
  refreshTokenDays: number | null;
  /** Token name suffix to embed for traceability. */
  tokenLabel: string;
}

const NATIVE_UA_PREFIXES = [
  "HealthLog-iOS",
  "HealthLog-iPad",
  "HealthLog-Watch",
  "n8n",
  "Health-Connect",
];

export function classifyClient(headers: Headers): ClientPolicy {
  const explicit = headers.get("x-client-type")?.toLowerCase();
  if (explicit === "native") return "native";
  if (explicit === "web") return "web";

  const ua = headers.get("user-agent") ?? "";
  // Match the brief: web UAs contain "Mozilla/" and keep the 90d token.
  // Anything else (including blank UAs) is treated as native.
  if (ua.includes("Mozilla/")) return "web";
  for (const prefix of NATIVE_UA_PREFIXES) {
    if (ua.startsWith(prefix)) return "native";
  }
  // Unrecognised UAs default to the safer (shorter) token.
  return "native";
}

export function resolveTokenPolicy(headers: Headers): TokenPolicyDecision {
  const policy = classifyClient(headers);
  if (policy === "web") {
    return {
      policy,
      accessTokenDays: 90,
      refreshTokenDays: null,
      tokenLabel: "web",
    };
  }
  return {
    policy: "native",
    accessTokenDays: 1,
    refreshTokenDays: NATIVE_REFRESH_TOKEN_DAYS,
    tokenLabel: "native",
  };
}

/**
 * True only for a genuinely cookie-less native caller — the gate for
 * *issuing* a 60-day refresh token (M-3 hardening).
 *
 * A refresh token is a long-lived secret. It must never be delivered into
 * a browser context (DOM/XSS-reachable), even when that browser spoofs
 * `X-Client-Type: native`. Two browser tells suppress issuance:
 *   - a `Mozilla/`-bearing User-Agent (every real browser sends one), and
 *   - an inbound session cookie, under either of its names (a browser round-trips its
 *     session cookie; the native client authenticates by Bearer and never
 *     holds one).
 *
 * The genuine iOS/native path (native signal, `HealthLog-*`/blank UA, no
 * session cookie) is unaffected and still receives its refresh token.
 */
export function isCookielessNativeCaller(headers: Headers): boolean {
  if (classifyClient(headers) !== "native") return false;

  // A real browser always carries a Mozilla/ UA even when it spoofs the
  // X-Client-Type header, so this is the primary suppression signal.
  const ua = headers.get("user-agent") ?? "";
  if (ua.includes("Mozilla/")) return false;

  // Belt-and-braces: a request that presents the session cookie is a
  // browser round-trip regardless of UA. Native callers never hold one.
  if (cookieHeaderCarriesSession(headers.get("cookie"))) return false;

  return true;
}

/** True when the caller should receive a Bearer token in the response body. */
export function shouldIssueBearerToken(headers: Headers): boolean {
  // Explicit native opt-in OR a recognised native UA. Plain web sessions
  // continue to authenticate via the session cookie alone (no token
  // payload), which prevents the 90-day token from leaking out for the
  // huge population of users who already have working browser auth.
  const explicit = headers.get("x-client-type")?.toLowerCase();
  if (explicit === "native") return true;
  if (explicit === "web") return false;

  const ua = headers.get("user-agent") ?? "";
  if (ua.startsWith("HealthLog-iOS") || ua.startsWith("HealthLog-iPad"))
    return true;
  for (const prefix of NATIVE_UA_PREFIXES) {
    if (ua.startsWith(prefix)) return true;
  }
  return false;
}
