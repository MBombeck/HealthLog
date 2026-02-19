import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, apiError } from "@/lib/api-response";
import { decrypt } from "@/lib/crypto";
import { unsubscribeWebhook } from "@/lib/withings/client";
import { getWithingsWebhookCallbackUrl } from "@/lib/withings/sync";

/**
 * Disconnect Withings integration for the current user.
 */
export async function POST() {
  const sessionData = await getSession();
  if (!sessionData) return apiError("Nicht angemeldet", 401);

  const connection = await prisma.withingsConnection.findUnique({
    where: { userId: sessionData.user.id },
  });

  if (!connection) {
    return apiError("Keine Withings-Verbindung vorhanden", 404);
  }

  // Try to unsubscribe webhook (best-effort)
  try {
    const accessToken = decrypt(connection.accessToken);
    const callbackUrl = getWithingsWebhookCallbackUrl();
    await unsubscribeWebhook(accessToken, callbackUrl);
  } catch {
    // Ignore — token might be expired
  }

  await prisma.withingsConnection.delete({
    where: { userId: sessionData.user.id },
  });

  await auditLog("withings.disconnect", {
    userId: sessionData.user.id,
  });

  return apiSuccess({ disconnected: true });
}
