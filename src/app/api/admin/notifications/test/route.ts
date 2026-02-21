import { requireAdmin } from "@/lib/auth/session";
import { apiError, apiSuccess } from "@/lib/api-response";
import { dispatchNotification } from "@/lib/notifications/dispatcher";

export const dynamic = "force-dynamic";

export async function POST() {
  const admin = await requireAdmin();
  if (!admin) return apiError("Nicht berechtigt", 403);

  try {
    await dispatchNotification({
      eventType: "SYSTEM_ALERT",
      userId: admin.id,
      title: "Test-Notification",
      message:
        "<b>HealthLog Test:</b> Wenn du diese Nachricht siehst, funktionieren deine Benachrichtigungen!",
    });

    return apiSuccess({
      sent: true,
      message: "Test-Notification wurde gesendet",
    });
  } catch (error) {
    console.error("Notification test failed:", error);
    return apiError("Test-Notification konnte nicht gesendet werden", 500);
  }
}
