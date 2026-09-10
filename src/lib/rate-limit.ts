/**
 * PostgreSQL-based sliding window rate limiter.
 * Uses atomic upsert via raw SQL for correctness across multiple instances.
 */

import { prisma } from "@/lib/db";
import { getClientIpOrTrustWarning } from "@/lib/api-response";
import {
  captureRateLimitResult,
  rateLimitResponseHeaders,
  type RateLimitSnapshot,
} from "@/lib/rate-limit-context";

export interface RateLimitResult extends RateLimitSnapshot {
  allowed: boolean;
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

  const result: RateLimitResult = {
    allowed: count <= limit,
    limit,
    remaining: Math.max(0, limit - count),
    resetAt,
  };
  // Hand the verdict to the request-scoped cell so `apiHandler` can dress a
  // bare 429 on the way out. A no-op outside a request.
  captureRateLimitResult(result);
  return result;
}

/**
 * Give one slot back to a bucket whose charge turned out to be premature.
 *
 * A caller that charges the bucket up front (to keep the 429 cheap) but then
 * fails BEFORE doing the metered work refunds the slot so the user's allowance
 * reflects work actually performed, not attempts. Scoped to the live window:
 * once `reset_at` has passed the counter is stale and a decrement would bleed
 * into the NEXT window's budget, so an expired row is left untouched. Never
 * drops below zero (concurrent refunds after a window flip are a no-op).
 *
 * Known slack: if the charge's window expires and a new request opens the
 * NEXT window before a late refund lands, the refund decrements that fresh
 * window instead — at most one extra slot there, only on failure paths that
 * never reached the metered work. Accepted; carrying the charge's `reset_at`
 * through every failure path is not worth one slot of slack.
 */
export async function refundRateLimit(key: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE rate_limits
    SET count = GREATEST(count - 1, 0)
    WHERE key = ${key} AND reset_at >= NOW()
  `;
}

/**
 * Rate limit response headers: `Retry-After` plus the `X-RateLimit-*` triple.
 * See `rateLimitResponseHeaders` for what each one promises.
 */
export function rateLimitHeaders(
  result: RateLimitSnapshot,
): Record<string, string> {
  return rateLimitResponseHeaders(result);
}

/**
 * v1.15.20 — shared per-user budget for the heavy read-only analytics
 * surfaces (`/api/insights/comprehensive`, `/api/insights/correlations`,
 * `/api/insights/derived`, `/api/analytics/range`). The insights page
 * legitimately fans several of these out per mount, so the bucket is
 * generous — 120/min only caps a runaway client loop or a scripted
 * drain, mirroring the `sync:changes` budget. One shared bucket (not
 * per-surface) keeps the cap meaningful when a loop rotates across
 * endpoints.
 */
const ANALYTICS_READ_LIMIT = 120;
const ANALYTICS_READ_WINDOW_MS = 60 * 1000;

export async function checkAnalyticsReadRateLimit(
  userId: string,
): Promise<RateLimitResult> {
  return checkRateLimit(
    `analytics-read:${userId}`,
    ANALYTICS_READ_LIMIT,
    ANALYTICS_READ_WINDOW_MS,
  );
}

/**
 * Shared per-account ceiling for the single-record writes.
 *
 * The batch endpoints have been capped at 60 calls a minute since they were
 * written; the per-record siblings a naive or older client loops over were not
 * capped at all, which is backwards — the batch endpoint is the one a
 * well-behaved client uses. This is the floor under the other direction:
 * `POST /api/measurements`, `/api/mood-entries`, both medication-intake writes,
 * `/api/labs`, a custom-metric entry, a cycle day-log, a vaccination, an
 * allergy, a biomarker and an encounter.
 *
 * One shared bucket, not one per route, for the reason
 * `checkAnalyticsReadRateLimit` gives: a loop that rotates across ten creates
 * should still meet a cap. Three hundred a minute is five writes a second
 * sustained for a full minute — no hand-driven session and no sync burst
 * reaches it. Ten of the eleven are wrapped in `withIdempotency`, so an honest
 * retry storm is deduplicated before it is counted; `POST
 * /api/medications/intake` is not, because it updates a named `intakeId`
 * rather than creating a row, so a replay writes the status that is already
 * there. It exists to cut off the pathological loop, not to shape traffic.
 *
 * A refused request is counted too: the check runs before the body is read,
 * so a client looping on a 422 spends its allowance without writing a row.
 *
 * Keyed on the ACTING account rather than the record, the frozen precedent from
 * the delegable medication routes: a delegate burns their own allowance rather
 * than locking the record's owner out of their own log, and cannot collect a
 * fresh one by switching records.
 */
export const RECORD_WRITE_BUCKET_PREFIX = "record-write";
export const RECORD_WRITE_LIMIT = 300;
export const RECORD_WRITE_WINDOW_MS = 60 * 1000;

export async function checkRecordWriteRateLimit(
  accountId: string,
): Promise<RateLimitResult> {
  return checkRateLimit(
    `${RECORD_WRITE_BUCKET_PREFIX}:${accountId}`,
    RECORD_WRITE_LIMIT,
    RECORD_WRITE_WINDOW_MS,
  );
}

/**
 * v1.22.0 — per-credential ceiling for the remote MCP endpoint (`/mcp`).
 * The bucket is keyed by the `<userId>:<tokenId>` binding the Bearer
 * resolver surfaces — NOT the user alone — so a single leaked / shared
 * token cannot exhaust the budget for the account's other tokens, and the
 * cap is scoped to the exact credential in use (REQ-SEC-9, REQ-SEC-11).
 * An MCP client legitimately fans several tool calls out per turn, so the
 * window is generous; it only caps a runaway loop or a scripted drain.
 */
const MCP_LIMIT = 120;
const MCP_WINDOW_MS = 60 * 1000;

export async function checkMcpRateLimit(
  binding: string,
): Promise<RateLimitResult> {
  return checkRateLimit(`mcp:${binding}`, MCP_LIMIT, MCP_WINDOW_MS);
}

/**
 * v1.22.0 — tighter per-credential ceiling for the remote MCP WRITE surface
 * (the `log_measurement` / `log_mood` tools), applied ON TOP of the general
 * `/mcp` per-binding request limiter. Keyed by the same `<userId>:<tokenId>`
 * binding so a single leaked / shared write-scoped token cannot flood writes
 * into the account, and the cap is scoped to the exact credential in use.
 * Writes are deliberate, low-frequency events, so this is far tighter than the
 * read budget — 60 confirmed writes per 5 minutes only caps a runaway loop.
 */
const MCP_WRITE_LIMIT = 60;
const MCP_WRITE_WINDOW_MS = 5 * 60 * 1000;

export async function checkMcpWriteRateLimit(
  binding: string,
): Promise<RateLimitResult> {
  return checkRateLimit(
    `mcp-write:${binding}`,
    MCP_WRITE_LIMIT,
    MCP_WRITE_WINDOW_MS,
  );
}

/**
 * v1.16.16 — per-user ceiling for the AI-consent surfaces
 * (`POST /api/consent/ai`, `POST /api/consent/ai/web`,
 * `GET/DELETE /api/consent/ai/latest`). The web client calls the heal
 * endpoint on every AI-settings mount and the iOS toggle hits grant/revoke
 * per flip, so the bucket is generous — 20/min only caps a scripted loop or
 * a stolen session pinning the receipts table, mirroring the coach-chat
 * ceiling. One shared bucket keyed by `userId` (not per-route) keeps the cap
 * meaningful when a loop rotates across the four endpoints.
 */
const CONSENT_LIMIT = 20;
const CONSENT_WINDOW_MS = 60 * 1000;

export async function checkConsentRateLimit(
  userId: string,
): Promise<RateLimitResult> {
  return checkRateLimit(`consent:${userId}`, CONSENT_LIMIT, CONSENT_WINDOW_MS);
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
