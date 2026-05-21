/**
 * PostgreSQL-based sliding window rate limiter.
 * Uses atomic upsert via raw SQL for correctness across multiple instances.
 */

import { prisma } from "@/lib/db";
import { getClientIpOrTrustWarning } from "@/lib/api-response";

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

/**
 * Check rate limit for a given key.
 * Uses a single atomic SQL upsert — safe for concurrent requests.
 * @param key Unique identifier (e.g., "auth:login:1.2.3.4")
 * @param limit Max requests per window
 * @param windowMs Window duration in milliseconds
 */
export async function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): Promise<RateLimitResult> {
  const windowInterval = `${windowMs} milliseconds`;

  const rows = await prisma.$queryRaw<{ count: number; reset_at: Date }[]>`
    INSERT INTO rate_limits (key, count, reset_at)
    VALUES (${key}, 1, NOW() + ${windowInterval}::interval)
    ON CONFLICT (key) DO UPDATE SET
      count = CASE
        WHEN rate_limits.reset_at < NOW() THEN 1
        ELSE rate_limits.count + 1
      END,
      reset_at = CASE
        WHEN rate_limits.reset_at < NOW() THEN NOW() + ${windowInterval}::interval
        ELSE rate_limits.reset_at
      END
    RETURNING count, reset_at
  `;

  const row = rows[0];
  const resetAt = row.reset_at.getTime();
  const count = Number(row.count);

  return {
    allowed: count <= limit,
    remaining: Math.max(0, limit - count),
    resetAt,
  };
}

/**
 * Rate limit response headers.
 */
export function rateLimitHeaders(
  result: RateLimitResult,
): Record<string, string> {
  return {
    "X-RateLimit-Remaining": String(result.remaining),
    "X-RateLimit-Reset": new Date(result.resetAt).toISOString(),
  };
}

/**
 * v1.4.43 W13 M-4 — anonymous/trust-violation bucket key shared by every
 * caller of `checkAuthSurfaceRateLimit`. When `TRUST_PROXY_HOPS` and the
 * actual proxy chain don't agree, `getClientIp` returns null and every
 * caller falls back to a literal `"unknown"` rate-limit bucket. Any
 * attacker can then exhaust the `auth:login:unknown` bucket and lock
 * every other legitimate anonymous caller out of the surface.
 *
 * The tighter bucket is shared across every auth surface — a misconfigured
 * deployment with the trust chain broken accepts at most this many
 * anonymous attempts across login + register + passkey-verify + … per
 * window. Operators see the once-per-process `console.warn` from
 * `getClientIpOrTrustWarning` and fix the proxy chain; the tight bucket
 * caps the blast radius while they do.
 */
const TIGHT_ANON_KEY = "auth:anon:trust-violation";
const TIGHT_ANON_LIMIT = 100;
const TIGHT_ANON_WINDOW_MS = 15 * 60 * 1000;

/**
 * Rate-limit helper for anonymous auth surfaces (login, register,
 * passkey-login-{options,verify}, refresh, check-user).
 *
 * Per-IP path: when the trust chain resolves cleanly, route the request
 * to a bucket keyed by `{prefix}:{ip ?? "unknown"}` with the caller's
 * supplied limit + window. Existing semantics, byte-for-byte.
 *
 * Tightened path: when `getClientIpOrTrustWarning` reports
 * `trustViolation === true`, the configured proxy hops and the actual
 * chain length don't match. Every anonymous caller already shares a
 * single `"unknown"` bucket on the per-IP path; this helper instead
 * routes them to a fixed global bucket with a strict 100/15min cap.
 * One attacker can no longer exhaust the per-surface bucket — they hit
 * the global cap first, and every other anonymous caller on any auth
 * surface shares the same cap.
 *
 * The returned shape matches `checkRateLimit` so call sites can attach
 * `rateLimitHeaders(rl)` unchanged.
 */
export async function checkAuthSurfaceRateLimit(
  request: Request,
  prefix: string,
  perIpLimit: number,
  windowMs: number,
): Promise<RateLimitResult & { ip: string | null }> {
  const { ip, trustViolation } = getClientIpOrTrustWarning(request);
  if (trustViolation) {
    const result = await checkRateLimit(
      TIGHT_ANON_KEY,
      TIGHT_ANON_LIMIT,
      TIGHT_ANON_WINDOW_MS,
    );
    return { ...result, ip };
  }
  const result = await checkRateLimit(
    `${prefix}:${ip ?? "unknown"}`,
    perIpLimit,
    windowMs,
  );
  return { ...result, ip };
}
