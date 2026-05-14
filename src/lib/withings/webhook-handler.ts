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

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const formData = await request.formData();
    withingsUserId = formData.get("userid") as string;
  } else {
    const { data: body, error: jsonError } = await safeJson<{
      userid?: string | number;
    }>(request);
    if (jsonError) return jsonError;
    withingsUserId = body.userid?.toString() ?? null;
  }

  if (!withingsUserId) {
    return NextResponse.json({ status: "ignored" }, { status: 200 });
  }

  annotate({ meta: { withings_user_id: withingsUserId } });

  const connection = await prisma.withingsConnection.findFirst({
    where: { withingsUserId },
  });

  if (!connection) {
    getEvent()?.addWarning(
      "Webhook for unknown withings user: " + withingsUserId,
    );
    return NextResponse.json({ status: "unknown_user" }, { status: 200 });
  }

  syncUserMeasurements(connection.userId).catch((err) => {
    getEvent()?.addWarning(
      "Sync failed for user " + connection.userId + ": " + err,
    );
  });

  return NextResponse.json({ status: "ok" }, { status: 200 });
}
