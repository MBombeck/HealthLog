import { timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/db";
import { syncUserMeasurements } from "@/lib/withings/sync";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { getClientIp, safeJson } from "@/lib/api-response";
import { NextRequest, NextResponse } from "next/server";
import { apiHandler } from "@/lib/api-handler";
import { annotate, getEvent } from "@/lib/logging/context";

/**
 * Audit C-3 / phase P2: Withings legacy callback URLs include the shared
 * secret as a `?secret=…` query param, which leaks into reverse-proxy
 * access logs and any error-tracking pipeline that captures `request.url`
 * (see `reportToGlitchtip`). New deployments should configure Withings to
 * send the secret via the `X-Withings-Webhook-Secret` header instead.
 *
 * The query-param fallback stays for backwards compatibility with existing
 * Withings configurations; remove once all integrators have migrated.
 */
function hasValidWebhookSecret(request: NextRequest): boolean {
  const expected = process.env.WITHINGS_WEBHOOK_SECRET;
  if (!expected) {
    getEvent()?.addWarning("WITHINGS_WEBHOOK_SECRET not configured");
    return false;
  }

  const fromHeader = request.headers.get("x-withings-webhook-secret");
  const fromQuery = request.nextUrl.searchParams.get("secret");
  const received = fromHeader ?? fromQuery;
  if (!received) return false;

  if (!fromHeader && fromQuery) {
    getEvent()?.addWarning(
      "withings webhook secret received via legacy URL query — migrate to X-Withings-Webhook-Secret header",
    );
  }

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(received, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Withings webhook notification endpoint.
 * Withings sends a POST when new measurements are available.
 * The webhook sends: userid, startdate, enddate, appli
 */
export const POST = apiHandler(async (request: NextRequest) => {
  annotate({ action: { name: "withings.webhook" } });

  const ip = getClientIp(request);
  const rl = await checkRateLimit(`withings-webhook:${ip}`, 30, 60 * 1000);
  if (!rl.allowed) {
    return NextResponse.json(
      { status: "rate_limited" },
      { status: 429, headers: rateLimitHeaders(rl) },
    );
  }

  if (!hasValidWebhookSecret(request)) {
    return NextResponse.json({ status: "unauthorized" }, { status: 401 });
  }

  getEvent()?.setAuth({ auth_method: "webhook_secret" });

  // Withings sends form-encoded or JSON depending on version
  const contentType = request.headers.get("content-type") ?? "";
  let withingsUserId: string | null = null;

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const formData = await request.formData();
    withingsUserId = formData.get("userid") as string;
  } else {
    const { data: body, error: jsonError } = await safeJson<{ userid?: string | number }>(request);
    if (jsonError) return jsonError;
    withingsUserId = body.userid?.toString() ?? null;
  }

  if (!withingsUserId) {
    return NextResponse.json({ status: "ignored" }, { status: 200 });
  }

  annotate({ meta: { withings_user_id: withingsUserId } });

  // Find user by Withings user ID
  const connection = await prisma.withingsConnection.findFirst({
    where: { withingsUserId },
  });

  if (!connection) {
    getEvent()?.addWarning("Webhook for unknown withings user: " + withingsUserId);
    return NextResponse.json({ status: "unknown_user" }, { status: 200 });
  }

  // Sync measurements (non-blocking response for Withings)
  syncUserMeasurements(connection.userId).catch((err) => {
    getEvent()?.addWarning("Sync failed for user " + connection.userId + ": " + err);
  });

  return NextResponse.json({ status: "ok" }, { status: 200 });
});

/**
 * Withings sends a HEAD request to verify the webhook URL.
 */
export const HEAD = apiHandler(async (request: NextRequest) => {
  annotate({ action: { name: "withings.webhook.verify" } });

  if (!hasValidWebhookSecret(request)) {
    return new NextResponse(null, { status: 401 });
  }
  getEvent()?.setAuth({ auth_method: "webhook_secret" });
  return new NextResponse(null, { status: 200 });
});

export const GET = apiHandler(async (request: NextRequest) => {
  annotate({ action: { name: "withings.webhook.verify" } });

  if (!hasValidWebhookSecret(request)) {
    return NextResponse.json({ status: "unauthorized" }, { status: 401 });
  }
  getEvent()?.setAuth({ auth_method: "webhook_secret" });
  return NextResponse.json({ status: "ok" }, { status: 200 });
});
