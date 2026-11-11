import type { NextRequest } from "next/server";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess, apiError } from "@/lib/api-response";
import { checkRateLimit } from "@/lib/rate-limit";
import { annotate } from "@/lib/logging/context";
import { coerceLocale } from "@/lib/i18n/config";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { sendViaWebPush } from "@/lib/notifications/senders/web-push";

export const dynamic = "force-dynamic";

/**
 * POST /api/notifications/web-push/test
 *
 * Sends a test push to every browser subscribed for the account, through the
 * sender real reminders use, in the account's language. Pressing Test on one
 * device must reach that device; the newest subscription alone did not when
 * a person had more than one.
 */
export const POST = apiHandler(async (request: NextRequest) => {
  void request;
  const { user } = await requireAuth();
  annotate({ action: { name: "notifications.web-push.test" } });

  const rl = await checkRateLimit(`web-push-test:${user.id}`, 5, 60_000);
  if (!rl.allowed) {
    return apiError("Too many test requests", 429, {
      errorCode: "rate_limited_self",
    });
  }

  const { t } = getServerTranslator(coerceLocale(user.locale));
  const start = performance.now();
  const result = await sendViaWebPush(user.id, {
    eventType: "SYSTEM_ALERT",
    userId: user.id,
    title: t("notifications.admin.testNotificationTitle"),
    message: t("notifications.user.webPushTestBody"),
    metadata: { webPushTag: "self-test" },
  });
  const latencyMs = Math.round(performance.now() - start);

  if (result.reason === "web_push_no_subscriptions") {
    return apiError("No push subscriptions registered", 422, {
      errorCode: "not_configured",
    });
  }
  if (result.reason === "web_push_vapid_not_configured") {
    return apiError("VAPID keys not configured", 422, {
      errorCode: "vapid_not_configured",
    });
  }

  annotate({
    meta: { web_push_test_ok: result.ok, web_push_test_reason: result.reason },
  });
  return apiSuccess(
    result.ok ? { ok: true, latencyMs } : { ok: false, reason: result.reason },
  );
});
