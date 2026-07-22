/**
 * Shared body processing + signature verification for the WHOOP webhook
 * endpoint (`POST /api/whoop/webhook/[token]`). Mirrors the Withings
 * `webhook-handler.ts` shape, with one genuine improvement: WHOOP signs the
 * body, so we verify an HMAC-SHA256 signature in addition to the path-segment
 * secret (Withings can't sign, so it only has the path secret).
 *
 * WHOOP webhook contract (API v2):
 *   - headers `X-WHOOP-Signature` (base64) + `X-WHOOP-Signature-Timestamp`
 *     (ms epoch);
 *   - signature = `base64(HMAC-SHA256(timestamp + rawBody, secret))`;
 *   - body `{ user_id: number, id: string|number, type: string, trace_id }`
 *     where `type` is e.g. `recovery.updated` / `sleep.updated` /
 *     `workout.updated` (+ the matching `*.deleted`). Creates arrive as
 *     `*.updated`. The payload carries NO resource data — the per-resource
 *     sync job re-fetches by id.
 *
 * Auth layering, in order (every leg short-circuits before any work):
 *   1. per-source rate limit (BEFORE secret verify — DoS floor);
 *   2. path-segment secret `timingSafeStringEqual`;
 *   3. HMAC body signature `timingSafeEqual` over the raw bytes + a stale
 *      timestamp reject.
 *
 * Always returns 200 (even for an unknown WHOOP user) so WHOOP doesn't queue
 * retries forever for a disconnected account — same contract as Withings.
 */
import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/db";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/api-response";
import { annotate, getEvent } from "@/lib/logging/context";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";

/**
 * Maximum age of a webhook timestamp before it is treated as a replay. Five
 * minutes comfortably covers clock skew + delivery latency while bounding the
 * window an attacker has to replay a captured (signed) body.
 */
const WHOOP_SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * Resource-`type` prefix → pg-boss queue name. The webhook only enqueues a
 * per-user job; the worker re-fetches the resource by id. Cycle has no
 * webhook (poll-only) so it is intentionally absent.
 */
const WHOOP_RESOURCE_QUEUE: Record<string, string> = {
  recovery: "whoop-recovery-sync",
  sleep: "whoop-sleep-sync",
  workout: "whoop-workout-sync",
};

/**
 * Constant-time string comparison. Returns false unless both inputs have the
 * same byte length AND match exactly.
 */
export async function timingSafeStringEqual(
  expected: string,
  received: string,
): Promise<boolean> {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(received, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Apply the per-source rate limit every WHOOP webhook delivery shares.
 * Returns a `NextResponse` when the request must be rejected, `null` when it
 * should continue. Runs BEFORE secret/signature verification so a flood of
 * forged deliveries can't drive unbounded crypto work.
 */
export async function applyWebhookRateLimit(
  request: NextRequest,
): Promise<NextResponse | null> {
  const ip = getClientIp(request);
  const rl = await checkRateLimit(`whoop-webhook:${ip}`, 60, 60 * 1000);
  if (!rl.allowed) {
    return NextResponse.json(
      { status: "rate_limited" },
      { status: 429, headers: rateLimitHeaders(rl) },
    );
  }
  return null;
}

/**
 * Verify the WHOOP HMAC body signature against the raw request bytes.
 *
 * `secret` is the per-instance `WHOOP_WEBHOOK_SECRET`. The base string is
 * `timestamp + rawBody` (timestamp first, per the WHOOP v2 spec). Returns
 * true only when the timestamp is fresh AND the recomputed signature matches
 * the `X-WHOOP-Signature` header byte-for-byte under a constant-time compare.
 */
export function verifyWhoopSignature(args: {
  rawBody: string;
  signature: string | null;
  timestamp: string | null;
  secret: string;
  now?: number;
}): boolean {
  const { rawBody, signature, timestamp, secret } = args;
  if (!signature || !timestamp) return false;

  const ts = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) return false;
  const now = args.now ?? Date.now();
  if (Math.abs(now - ts) > WHOOP_SIGNATURE_MAX_AGE_MS) return false;

  const expected = createHmac("sha256", secret)
    .update(timestamp + rawBody, "utf8")
    .digest("base64");

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

interface WhoopWebhookBody {
  user_id?: number | string;
  id?: number | string;
  type?: string;
}

/**
 * Process an authenticated + signature-verified WHOOP notification. Resolves
 * the `WhoopConnection` by `whoopUserId`, then either enqueues the matching
 * per-resource sync job (`*.updated`) or soft-deletes the matching rows
 * (`*.deleted`). The caller has already verified rate limit + path secret +
 * HMAC signature and parsed the body.
 */
export async function processWhoopNotification(
  body: WhoopWebhookBody,
): Promise<Response> {
  getEvent()?.setAuth({ auth_method: "webhook_secret" });

  const whoopUserId = body.user_id != null ? String(body.user_id) : null;
  const type = typeof body.type === "string" ? body.type : null;
  const resourceId = body.id != null ? String(body.id) : null;

  if (!whoopUserId || !type) {
    annotate({ action: { name: "whoop.webhook.ignored" } });
    return NextResponse.json({ status: "ignored" }, { status: 200 });
  }

  const connection = await prisma.whoopConnection.findUnique({
    where: { whoopUserId },
    select: { userId: true },
  });
  if (!connection) {
    // Unknown / disconnected user. Return 200 so WHOOP stops retrying.
    annotate({ action: { name: "whoop.webhook.unknown_user" } });
    return NextResponse.json({ status: "unknown_user" }, { status: 200 });
  }

  const [resource, verb] = type.split(".");
  const queue = WHOOP_RESOURCE_QUEUE[resource ?? ""];

  if (verb === "deleted") {
    // Soft-delete every matching row for this user + WHOOP resource id.
    // `externalId` is `<whoop-resource-uuid>:<field-tag>` so a `startsWith`
    // match catches every measurement derived from the deleted resource.
    if (resourceId) {
      const now = new Date();
      await prisma.measurement.updateMany({
        where: {
          userId: connection.userId,
          source: "WHOOP",
          externalId: { startsWith: `${resourceId}:` },
          deletedAt: null,
        },
        data: { deletedAt: now, syncVersion: { increment: 1 } },
      });
      if (resource === "workout") {
        // The Workout model carries no soft-delete column, so a deleted
        // WHOOP workout is removed outright (keyed by the canonical
        // `(userId, source, externalId)` unique).
        await prisma.workout.deleteMany({
          where: {
            userId: connection.userId,
            source: "WHOOP",
            externalId: resourceId,
          },
        });
      }
    }
    annotate({
      action: { name: "whoop.webhook.deleted" },
      meta: { resource: resource ?? "unknown" },
    });
    return NextResponse.json({ status: "ok" }, { status: 200 });
  }

  if (!queue) {
    // A resource type with no webhook-driven sync queue (e.g. cycle is
    // poll-only). Acknowledge so WHOOP doesn't retry.
    annotate({
      action: { name: "whoop.webhook.no_queue" },
      meta: { resource: resource ?? "unknown" },
    });
    return NextResponse.json({ status: "ignored" }, { status: 200 });
  }

  // `*.updated` (creates arrive as updates too). Enqueue the per-user
  // resource sync. The payload carries the resource id so the worker can do a
  // targeted fetch-by-id refresh — landing the exact record immediately rather
  // than waiting for the next overlap window to re-walk the collection.
  const boss = getGlobalBoss();
  if (!boss) {
    getEvent()?.addWarning("whoop-webhook: pg-boss not initialised");
    return NextResponse.json({ status: "ok" }, { status: 200 });
  }
  await boss.send(queue, {
    userId: connection.userId,
    resourceId: resourceId ?? undefined,
  });

  annotate({
    action: { name: "whoop.webhook.enqueued" },
    meta: { resource: resource ?? "unknown" },
  });
  return NextResponse.json({ status: "ok" }, { status: 200 });
}
