import type { NextRequest } from "next/server";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess, apiError } from "@/lib/api-response";
import { checkRateLimit } from "@/lib/rate-limit";
import { annotate } from "@/lib/logging/context";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { getVapidConfig } from "@/lib/notifications/vapid-config";

export const dynamic = "force-dynamic";

function hostFromEndpoint(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return "unknown";
  }
}

// Strip any URL from a stringified web-push library error. Push providers (FCM,
// Mozilla autopush, etc.) embed the full subscription endpoint into 410/404
// error messages — that endpoint token is the routing secret, so it must never
// land in our Wide Events.
function redactPushError(text: string): string {
  return text.replace(/https?:\/\/\S+/gi, "[endpoint]");
}

export const POST = apiHandler(async (_request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "notifications.web-push.test" } });

  const rl = await checkRateLimit(`web-push-test:${user.id}`, 5, 60_000);
  if (!rl.allowed) {
    return apiError("Too many test requests", 429, {
      errorCode: "rate_limited_self",
    });
  }

  // Spec: only the most-recent subscription receives the test push. A user
  // with phone + tablet + desktop should not get three buzzes per click.
  const subscription = await prisma.pushSubscription.findFirst({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
  });

  if (!subscription) {
    return apiError("No push subscriptions registered", 422, {
      errorCode: "not_configured",
    });
  }

  const config = await getVapidConfig();
  if (!config) {
    return apiError("VAPID keys not configured", 422, {
      errorCode: "vapid_not_configured",
    });
  }

  const webpush = await import("web-push");
  webpush.setVapidDetails(config.subject, config.publicKey, config.privateKey);

  const pushPayload = JSON.stringify({
    title: "HealthLog",
    body: "This is a test notification from HealthLog",
    tag: "self-test",
  });

  const host = hostFromEndpoint(subscription.endpoint);
  const start = performance.now();

  try {
    const p256dh = decrypt(subscription.p256dh);
    const auth = decrypt(subscription.auth);

    const result = await webpush.sendNotification(
      { endpoint: subscription.endpoint, keys: { p256dh, auth } },
      pushPayload,
    );
    const latencyMs = Math.round(performance.now() - start);

    return apiSuccess({
      ok: true,
      sent: 1,
      latencyMs,
      perEndpoint: [{ host, status: result.statusCode ?? 201 }],
    });
  } catch (err: unknown) {
    const status = (err as { statusCode?: number }).statusCode ?? null;
    const message = redactPushError((err as Error).message ?? "").slice(0, 200);
    annotate({
      meta: {
        web_push_test_status: status,
        web_push_test_host: host,
        web_push_test_error: message,
      },
    });
    return apiSuccess({
      ok: false,
      sent: 0,
      perEndpoint: [{ host, status }],
    });
  }
});
