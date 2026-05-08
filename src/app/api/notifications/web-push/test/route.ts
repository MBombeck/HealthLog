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

export const POST = apiHandler(async (_request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "notifications.web-push.test" } });

  const rl = await checkRateLimit(`web-push-test:${user.id}`, 5, 60_000);
  if (!rl.allowed) return apiError("Too many test requests", 429);

  const subscriptions = await prisma.pushSubscription.findMany({
    where: { userId: user.id },
  });

  if (subscriptions.length === 0) {
    return apiError("No push subscriptions registered", 422);
  }

  const config = await getVapidConfig();
  if (!config) {
    return apiError("VAPID keys not configured", 422);
  }

  const webpush = await import("web-push");
  webpush.setVapidDetails(config.subject, config.publicKey, config.privateKey);

  const pushPayload = JSON.stringify({
    title: "HealthLog",
    body: "Push test",
    tag: "self-test",
  });

  let sent = 0;
  let failed = 0;
  const perEndpoint: Array<{ host: string; status: number | null }> = [];

  for (const sub of subscriptions) {
    const host = hostFromEndpoint(sub.endpoint);
    try {
      const p256dh = decrypt(sub.p256dh);
      const auth = decrypt(sub.auth);

      const result = await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh, auth } },
        pushPayload,
      );
      sent += 1;
      perEndpoint.push({ host, status: result.statusCode ?? 201 });
    } catch (err: unknown) {
      failed += 1;
      const status = (err as { statusCode?: number }).statusCode ?? null;
      perEndpoint.push({ host, status });
      annotate({
        meta: {
          web_push_test_error: ((err as Error).message ?? "").slice(0, 200),
          web_push_test_status: status,
        },
      });
    }
  }

  return apiSuccess({
    ok: sent > 0,
    sent,
    failed,
    perEndpoint,
  });
});
