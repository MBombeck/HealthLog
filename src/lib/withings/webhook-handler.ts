/**
 * Shared body processing for the Withings webhook endpoint family.
 *
 * Two routes share this logic:
 *
 *   - `POST /api/withings/webhook`           (legacy: secret via header or
 *                                             `?secret=` query, kept alive
 *                                             during the migration window)
 *   - `POST /api/withings/webhook/[token]`   (v1.4.25 W17a: secret as a
 *                                             path segment so it never
 *                                             reaches a reverse-proxy
 *                                             `query_string` access-log
 *                                             column nor the GlitchTip
 *                                             URL/breadcrumb surface)
 *
 * Withings has no public mechanism for adding HTTP headers to outgoing
 * notifications and never signs the body — every `notify_subscribe`
 * call carries exactly six parameters (action, callbackurl, appli,
 * client_id, nonce, signature). The strongest authenticity surface a
 * subscriber controls is therefore the callback URL itself. Moving the
 * shared secret from `?secret=` (logged) to a path segment (also in the
 * URL, but never logged as a query parameter and uniformly redactable
 * by a single proxy rule) is the largest shift Withings supports
 * end-to-end.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { syncUserMeasurements } from "@/lib/withings/sync";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { getClientIp, safeJson } from "@/lib/api-response";
import { annotate, getEvent } from "@/lib/logging/context";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";

/**
 * v1.4.25 W17b/c — appli categories that have their own sync routine
 * fan-out. The measure path (appli=1/2/4) keeps the legacy inline
 * call to `syncUserMeasurements`; activity (16) and sleep v2 (44) hand
 * off to pg-boss so the webhook response stays fast and a slow sync
 * doesn't block subsequent deliveries on the same connection.
 */
const WITHINGS_ACTIVITY_APPLI = 16;
const WITHINGS_SLEEP_APPLI = 44;
const WITHINGS_ACTIVITY_QUEUE = "withings-activity-sync";
const WITHINGS_SLEEP_QUEUE = "withings-sleep-sync";

export type WithingsWebhookAuthOutcome =
  | { ok: true }
  | { ok: false; reason: "missing_secret" | "mismatch" | "not_configured" };

/**
 * Constant-time comparison helper. Returns false unless both inputs have
 * the same byte length AND match exactly.
 */
export async function timingSafeStringEqual(
  expected: string,
  received: string,
): Promise<boolean> {
  const { timingSafeEqual } = await import("node:crypto");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(received, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Apply the rate-limit envelope every Withings webhook entrypoint
 * shares. Returns a `NextResponse` when the request must be rejected,
 * `null` when it should continue.
 */
export async function applyWebhookRateLimit(
  request: NextRequest,
): Promise<NextResponse | null> {
  const ip = getClientIp(request);
  const rl = await checkRateLimit(`withings-webhook:${ip}`, 30, 60 * 1000);
  if (!rl.allowed) {
    return NextResponse.json(
      { status: "rate_limited" },
      { status: 429, headers: rateLimitHeaders(rl) },
    );
  }
  return null;
}

/**
 * Once the request is authorised, decode the body, look the user up,
 * and trigger a (non-blocking) sync. Returns the response Withings
 * should see — `200 ok` on success, `200 ignored` when the body has no
 * `userid`, `200 unknown_user` when the `userid` does not map to any
 * `WithingsConnection`. Withings retries on non-2xx, so we deliberately
 * return 200 even for "unrecognised user" so they don't queue retries
 * for a deleted account forever.
 */
export async function processWithingsNotification(
  request: NextRequest,
): Promise<Response> {
  getEvent()?.setAuth({ auth_method: "webhook_secret" });

  const contentType = request.headers.get("content-type") ?? "";
  let withingsUserId: string | null = null;
  let appli: number | null = null;

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const formData = await request.formData();
    withingsUserId = formData.get("userid") as string;
    const rawAppli = formData.get("appli");
    if (rawAppli != null) {
      const parsed = Number.parseInt(String(rawAppli), 10);
      if (Number.isFinite(parsed)) appli = parsed;
    }
  } else {
    const { data: body, error: jsonError } = await safeJson<{
      userid?: string | number;
      appli?: string | number;
    }>(request);
    if (jsonError) return jsonError;
    withingsUserId = body.userid?.toString() ?? null;
    if (body.appli != null) {
      const parsed = Number.parseInt(String(body.appli), 10);
      if (Number.isFinite(parsed)) appli = parsed;
    }
  }

  if (!withingsUserId) {
    return NextResponse.json({ status: "ignored" }, { status: 200 });
  }

  annotate({
    meta: {
      withings_user_id: withingsUserId,
      withings_appli: appli ?? null,
    },
  });

  const connection = await prisma.withingsConnection.findFirst({
    where: { withingsUserId },
  });

  if (!connection) {
    getEvent()?.addWarning(
      "Webhook for unknown withings user: " + withingsUserId,
    );
    return NextResponse.json({ status: "unknown_user" }, { status: 200 });
  }

  // v1.4.25 W17b/c — dispatch on appli category. Activity (16) and
  // sleep v2 (44) hand off to dedicated pg-boss queues so the webhook
  // response stays sub-100ms; the measure family (appli=1/2/4) keeps
  // the existing inline `syncUserMeasurements` call. An absent or
  // unknown `appli` defaults to the measure path — preserves the
  // pre-W17 behaviour for legacy subscriptions Withings hasn't
  // re-tagged yet.
  if (appli === WITHINGS_ACTIVITY_APPLI) {
    await enqueueWithingsSync(WITHINGS_ACTIVITY_QUEUE, connection.userId);
  } else if (appli === WITHINGS_SLEEP_APPLI) {
    await enqueueWithingsSync(WITHINGS_SLEEP_QUEUE, connection.userId);
  } else {
    syncUserMeasurements(connection.userId).catch((err) => {
      getEvent()?.addWarning(
        "Sync failed for user " + connection.userId + ": " + err,
      );
    });
  }

  return NextResponse.json({ status: "ok" }, { status: 200 });
}

/**
 * v1.4.25 W17b/c — enqueue a per-user activity / sleep sync job onto
 * the pg-boss queue. When pg-boss isn't available (Next.js dev server
 * without the worker process attached) we fall back to firing the
 * sync inline so dev iteration isn't blocked on a separate worker
 * process — same behaviour as the legacy measure path.
 */
async function enqueueWithingsSync(
  queueName: string,
  userId: string,
): Promise<void> {
  const boss = getGlobalBoss();
  if (!boss) {
    getEvent()?.addWarning(
      `pg-boss not initialised — falling back to inline ${queueName} for ${userId}`,
    );
    // Lazy-load so the webhook route doesn't pull in the activity /
    // sleep sync modules at cold-start when the worker process is up.
    if (queueName === WITHINGS_ACTIVITY_QUEUE) {
      const { syncUserActivity } = await import("./sync-activity");
      syncUserActivity(userId).catch((err) => {
        getEvent()?.addWarning(
          `Inline activity sync failed for ${userId}: ${err}`,
        );
      });
    } else if (queueName === WITHINGS_SLEEP_QUEUE) {
      const { syncUserSleep } = await import("./sync-sleep");
      syncUserSleep(userId).catch((err) => {
        getEvent()?.addWarning(
          `Inline sleep sync failed for ${userId}: ${err}`,
        );
      });
    }
    return;
  }
  try {
    await boss.send(queueName, { userId, triggeredAt: new Date().toISOString() });
  } catch (err) {
    getEvent()?.addWarning(
      `Failed to enqueue ${queueName} for ${userId}: ${err}`,
    );
  }
}
