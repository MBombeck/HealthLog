/**
 * v1.4.47.6 — per-channel APNs test endpoint.
 *
 * Mirrors `/api/notifications/web-push/test`: fires a single self-test
 * push to the calling user's iOS devices via `sendViaApns`. The
 * `notification-status-card` UI on the Settings page maps the
 * "Test senden" button on the APNS channel row to this endpoint.
 *
 * Why a separate endpoint per channel instead of `/api/admin/notifications/test`:
 * - The admin test endpoint requires admin role; the per-channel test
 *   is available to any authenticated user who owns the channel.
 * - The admin variant fans out to ALL channels at once; the per-channel
 *   variant lets the user verify a single channel after a fix without
 *   spamming the other channels too.
 */
import type { NextRequest } from "next/server";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess, apiError } from "@/lib/api-response";
import { checkRateLimit } from "@/lib/rate-limit";
import { annotate } from "@/lib/logging/context";
import { sendViaApns } from "@/lib/notifications/senders/apns";
import { defaultLocale, type Locale } from "@/lib/i18n/config";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

function isLocale(value: string | null | undefined): value is Locale {
  return (
    value === "de" ||
    value === "en" ||
    value === "fr" ||
    value === "es" ||
    value === "it" ||
    value === "pl"
  );
}

export const POST = apiHandler(async (request: NextRequest) => {
  void request;
  const { user } = await requireAuth();
  annotate({ action: { name: "notifications.apns.test" } });

  const rl = await checkRateLimit(`apns-test:${user.id}`, 5, 60_000);
  if (!rl.allowed) {
    return apiError("Too many test requests", 429, {
      errorCode: "rate_limited_self",
    });
  }

  const localeRow = await prisma.user.findUnique({
    where: { id: user.id },
    select: { locale: true },
  });
  const locale: Locale = isLocale(localeRow?.locale)
    ? localeRow.locale
    : defaultLocale;
  const t = getServerTranslator(locale).t;

  // Send as MEDICATION_REMINDER so the dispatcher's time-sensitive /
  // priority-10 branch fires. Otherwise the test runs at the default
  // `active` interruption-level and iOS may summarise it into the
  // Notification Center rather than presenting a lock-screen banner —
  // leaving the user with no signal whether real medication reminders
  // (which DO use time-sensitive) will surface on the lock screen.
  // The title/body strings still read "Test notification" so the user
  // doesn't mistake this for an actual scheduled dose.
  const result = await sendViaApns(user.id, {
    title: t("notifications.admin.testNotificationTitle"),
    message: t("notifications.admin.testNotificationBody"),
    eventType: "MEDICATION_REMINDER",
  });

  annotate({
    meta: {
      apns_test_ok: result.ok,
      apns_test_reason: result.ok ? undefined : result.reason,
    },
  });

  return apiSuccess({
    ok: result.ok,
    reason: result.ok ? undefined : result.reason,
  });
});
