import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, apiError } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { decrypt } from "@/lib/crypto";
import { unsubscribeWebhook } from "@/lib/withings/client";
import {
  WITHINGS_NOTIFY_APPLIS,
  getWithingsWebhookCallbackUrl,
} from "@/lib/withings/sync";
import { markDisconnected } from "@/lib/integrations/status";

/**
 * Disconnect Withings integration for the current user.
 */
export const POST = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "withings.disconnect" } });

  const connection = await prisma.withingsConnection.findUnique({
    where: { userId: user.id },
  });

  if (!connection) {
    return apiError("No Withings connection", 404);
  }

  // Best-effort unsubscribe across every appli category we subscribed
  // to in setupWebhook. A token-expired failure on one category should
  // not stop us from cleaning up the others.
  try {
    const accessToken = decrypt(connection.accessToken);
    const callbackUrl = getWithingsWebhookCallbackUrl();
    for (const appli of WITHINGS_NOTIFY_APPLIS) {
      try {
        await unsubscribeWebhook(accessToken, callbackUrl, appli);
      } catch {
        // Ignore — token might be expired or the appli was never subscribed.
      }
    }
  } catch {
    // Ignore — token might be undecryptable.
  }

  await prisma.withingsConnection.delete({
    where: { userId: user.id },
  });

  await auditLog("withings.disconnect", {
    userId: user.id,
  });

  await markDisconnected(user.id, "withings");

  return apiSuccess({ disconnected: true });
});
