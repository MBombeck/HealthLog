import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { apiSuccess, apiError } from "@/lib/api-response";
import { decrypt } from "@/lib/crypto";
import { sendViaNtfy } from "@/lib/notifications/senders/ntfy";
import type { NtfyChannelConfig } from "@/lib/notifications/types";

/**
 * POST: Send a test notification via ntfy.
 */
export async function POST() {
  const session = await getSession();
  if (!session) return apiError("Nicht angemeldet", 401);

  const channel = await prisma.notificationChannel.findUnique({
    where: {
      userId_type: { userId: session.user.id, type: "NTFY" },
    },
  });

  if (!channel) {
    return apiError("ntfy ist nicht konfiguriert", 400);
  }

  const config = JSON.parse(decrypt(channel.config)) as NtfyChannelConfig;

  if (!config.serverUrl || !config.topic) {
    return apiError("Server-URL und Topic sind erforderlich", 400);
  }

  const success = await sendViaNtfy(config, {
    eventType: "SYSTEM_ALERT",
    userId: session.user.id,
    title: "HealthLog Test",
    message:
      "HealthLog: Verbindung erfolgreich! ntfy-Benachrichtigungen sind aktiv.",
  });

  if (!success) {
    return apiError("Testnachricht konnte nicht gesendet werden", 500);
  }

  return apiSuccess({ sent: true });
}
