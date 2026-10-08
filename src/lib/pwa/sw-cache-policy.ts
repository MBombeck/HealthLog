/**
 * Service-worker offline-read cache policy (v1.18.6).
 *
 * The runtime copy of this logic lives inline in `public/sw.js` (a service
 * worker cannot import app modules at runtime). This module is the
 * unit-tested source of truth for the safety boundary — the allowlist match,
 * the auth/token deny guard, and the body-level secret refusal — so the SW's
 * caching decisions are covered by `pnpm test`. Keep the two in lockstep when
 * either changes.
 *
 * Boundary: ONLY idempotent GET reads that render the core views are cached.
 * Auth/mutation/token surfaces are never cached, and a body carrying a
 * secret-shaped token (`hlk_`/`hlr_`/`sk-`) is refused even if its path was
 * allowlisted by mistake — mirroring the idempotency cache's refusal.
 */

/**
 * The worker's own cache names: `healthlog-{static,pages,data}-<version>`.
 * Everything the app deletes from CacheStorage (session end, the "new
 * version" reload) matches against this and nothing else, so another app's
 * caches on the same origin are left alone. Keep in lockstep with
 * `HEALTHLOG_CACHE_NAME_RE` in `public/sw.js`.
 */
export const HEALTHLOG_CACHE_NAME_RE = /^healthlog-(?:static|pages|data)-/;

/**
 * Path prefixes whose safe GET reads are eligible for the offline data cache.
 *
 * v1.18.6 — AI/clinical narrative surfaces (`/api/insights`, `/api/analytics`)
 * are excluded: `/api/insights` prefix-matched the Coach chat endpoint
 * (`/api/insights/chat`) into the disk cache, and neither belongs on durable
 * storage. Only the dashboard snapshot, the widget layout, the measurement
 * reads (incl. the batched daily series), the medication reads, and the
 * version probe are cached.
 */
export const API_READ_ALLOWLIST = [
  "/api/dashboard/snapshot",
  "/api/dashboard/widgets",
  // v1.37.20 — the daily digest read: the Today rail is the first thing an
  // offline reopen renders, and the digest is an idempotent GET with no
  // secret in the body. The deny guard and the body-level refusal still
  // apply on top, like every entry here.
  "/api/daily/digest",
  "/api/measurements",
  "/api/medications",
  "/api/version",
] as const;

/** Auth/token surfaces refused even when nested under an allowlisted prefix. */
export const API_DENY_RE =
  /\/(auth|tokens?|sessions?|login|password|webauthn)(\/|$|\?)/i;

/** Secret-shaped token patterns refused at the response-body level. */
export const SECRET_BODY_RE = /(hlk_|hlr_|sk-)[A-Za-z0-9_-]/;

export function isAllowlistedApiRead(pathname: string): boolean {
  if (API_DENY_RE.test(pathname)) return false;
  return API_READ_ALLOWLIST.some(
    (p) =>
      pathname === p ||
      pathname.startsWith(p + "/") ||
      pathname.startsWith(p + "?"),
  );
}

/**
 * Decide whether an allowlisted response may be persisted. `ok` + no
 * `no-store` + no secret-shaped body. Mirrors `isCacheableApiResponse` in
 * `public/sw.js`.
 */
export function isCacheableApiResponse(opts: {
  ok: boolean;
  cacheControl?: string | null;
  bodyText?: string;
}): boolean {
  if (!opts.ok) return false;
  if (/no-store/i.test(opts.cacheControl || "")) return false;
  if (typeof opts.bodyText === "string" && SECRET_BODY_RE.test(opts.bodyText)) {
    return false;
  }
  return true;
}
