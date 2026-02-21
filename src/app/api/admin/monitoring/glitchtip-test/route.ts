import { requireAdmin } from "@/lib/auth/session";
import { apiError, apiSuccess } from "@/lib/api-response";
import { getGlitchtipSettings } from "@/lib/monitoring-settings";
import { sendGlitchtipEvent } from "@/lib/monitoring/glitchtip";

export const dynamic = "force-dynamic";

export async function POST() {
  const admin = await requireAdmin();
  if (!admin) return apiError("Nicht berechtigt", 403);

  const settings = await getGlitchtipSettings();
  if (!settings.glitchtipEnabled) {
    return apiError("Glitchtip ist deaktiviert", 422);
  }
  if (!settings.glitchtipDsn) {
    return apiError("Glitchtip DSN fehlt", 422);
  }

  try {
    const delivery = await sendGlitchtipEvent({
      dsn: settings.glitchtipDsn,
      input: {
        environment: settings.glitchtipEnvironment || "production",
        message: "HealthLog Monitoring Test",
        level: "error",
        type: "HealthLogMonitoringTest",
        sourceTag: "healthlog-admin-test",
      },
    });

    if (!delivery.ok) {
      console.error(
        "Glitchtip test event rejected:",
        delivery.method,
        delivery.status,
        delivery.details,
      );
      return apiError(
        `Glitchtip-Testevent wurde abgelehnt (HTTP ${delivery.status ?? 502})`,
        502,
      );
    }

    return apiSuccess({
      sent: true,
      message: "Glitchtip-Testevent wurde gesendet",
    });
  } catch (error) {
    console.error("Glitchtip test event failed:", error);
    return apiError("Glitchtip ist nicht erreichbar", 502);
  }
}
