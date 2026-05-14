import { NextRequest, NextResponse } from "next/server";
import { apiHandler } from "@/lib/api-handler";
import { annotate, getEvent } from "@/lib/logging/context";
import {
  applyWebhookRateLimit,
  processWithingsNotification,
  timingSafeStringEqual,
} from "@/lib/withings/webhook-handler";

/**
 * Legacy Withings webhook entrypoint.
 *
 * Pre-v1.4.25 callback URLs accepted the shared secret in two places:
 *
 *   1. `?secret=…`  — the original form, which Withings preserves on
 *                     every notification and which therefore lands in
 *                     reverse-proxy access logs (the `query_string`
 *                     column) and any error-tracking pipeline that
 *                     captures `request.url`.
 *   2. `X-Withings-Webhook-Secret` header — Withings does NOT support
 *                     setting custom headers on notifications, so this
 *                     path only fires for manual replay tests.
 *
 * v1.4.25 W17a moved the production path to
 * `/api/withings/webhook/[token]`, where the secret travels as a path
 * segment instead of a query parameter. This route stays alive for
 * one release cycle so existing Withings subscriptions keep delivering
 * while users re-subscribe (which also happens organically when they
 * reconnect for the new `user.activity` OAuth scope shipped in W5d).
 *
 * Removal target: v1.4.27 (after all live subscriptions have rotated).
 */
function hasValidWebhookSecret(
  request: NextRequest,
): Promise<{ ok: boolean; via: "header" | "query" | "none" }> {
  const expected = process.env.WITHINGS_WEBHOOK_SECRET;
  if (!expected) {
    getEvent()?.addWarning("WITHINGS_WEBHOOK_SECRET not configured");
    return Promise.resolve({ ok: false, via: "none" });
  }

  const fromHeader = request.headers.get("x-withings-webhook-secret");
  const fromQuery = request.nextUrl.searchParams.get("secret");
  const received = fromHeader ?? fromQuery;
  if (!received) return Promise.resolve({ ok: false, via: "none" });

  const via: "header" | "query" = fromHeader ? "header" : "query";
  return timingSafeStringEqual(expected, received).then((ok) => ({ ok, via }));
}

async function checkAndWarn(
  request: NextRequest,
): Promise<NextResponse | null> {
  const auth = await hasValidWebhookSecret(request);
  if (!auth.ok) {
    return NextResponse.json({ status: "unauthorized" }, { status: 401 });
  }
  if (auth.via === "query") {
    getEvent()?.addWarning(
      "withings webhook secret received via legacy URL query — migrate to /api/withings/webhook/[token]",
    );
  }
  return null;
}

/**
 * Withings webhook notification endpoint (legacy form).
 * Withings sends a POST when new measurements are available.
 * The webhook sends: userid, startdate, enddate, appli.
 */
export const POST = apiHandler(async (request: NextRequest) => {
  annotate({ action: { name: "withings.webhook.legacy" } });

  const limited = await applyWebhookRateLimit(request);
  if (limited) return limited;

  const unauth = await checkAndWarn(request);
  if (unauth) return unauth;

  return processWithingsNotification(request);
});

/**
 * Withings sends a HEAD request to verify the webhook URL.
 */
export const HEAD = apiHandler(async (request: NextRequest) => {
  annotate({ action: { name: "withings.webhook.verify" } });
  const auth = await hasValidWebhookSecret(request);
  if (!auth.ok) {
    return new NextResponse(null, { status: 401 });
  }
  getEvent()?.setAuth({ auth_method: "webhook_secret" });
  return new NextResponse(null, { status: 200 });
});

export const GET = apiHandler(async (request: NextRequest) => {
  annotate({ action: { name: "withings.webhook.verify" } });
  const auth = await hasValidWebhookSecret(request);
  if (!auth.ok) {
    return NextResponse.json({ status: "unauthorized" }, { status: 401 });
  }
  getEvent()?.setAuth({ auth_method: "webhook_secret" });
  return NextResponse.json({ status: "ok" }, { status: 200 });
});
