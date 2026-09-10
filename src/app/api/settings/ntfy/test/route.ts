import { prisma } from "@/lib/db";
import { apiSuccess, apiError } from "@/lib/api-response";
import { decrypt } from "@/lib/crypto";
import { sendViaNtfy } from "@/lib/notifications/senders/ntfy";
import type { NtfyChannelConfig } from "@/lib/notifications/types";
import { checkRateLimit } from "@/lib/rate-limit";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";

/**
 * POST: Send a test notification via ntfy.
 */
export const POST = apiHandler(async () => {
  const { user } = await requireAuth();

  const rl = await checkRateLimit(`ntfy-test:${user.id}`, 5, 5 * 60 * 1000);
  if (!rl.allowed) {
    return apiError("Maximum 5 tests in 5 minutes", 429);
  }

  const channel = await prisma.notificationChannel.findUnique({
    where: {
      userId_type: { userId: user.id, type: "NTFY" },
    },
  });

  if (!channel) {
    return apiError("ntfy is not configured", 400);
  }

  const config = JSON.parse(decrypt(channel.config)) as NtfyChannelConfig;

  if (!config.serverUrl || !config.topic) {
    return apiError("Server URL and topic are required", 400);
  }

  const result = await sendViaNtfy(config, {
    eventType: "SYSTEM_ALERT",
    userId: user.id,
    title: "HealthLog Test",
    message: "HealthLog: Connection successful! ntfy notifications are active.",
  });

  if (!result.ok) {
    // A private-origin refusal is a policy decision, not a delivery fault:
    // say so, with the code the card translates, instead of a bare 500 that
    // sends the operator to the wide-event log to learn why (#947).
    if (result.errorCode) {
      annotate({
        action: { name: "settings.ntfy.test" },
        meta: { success: false, refused: result.errorCode },
      });
      return apiError(
        result.errorCode === "private_origin_not_grantable"
          ? "The server is a link-local, metadata or unspecified address, which no operator grant can open. Use the address the relay actually listens on."
          : "The server is on a private network the operator has not approved. List its exact origin (scheme://host:port) in NOTIFICATION_PRIVATE_ORIGINS on the server.",
        422,
        { errorCode: result.errorCode },
      );
    }
    return apiError("Failed to send test message", 500);
  }

  annotate({ action: { name: "settings.ntfy.test" }, meta: { success: true } });

  return apiSuccess({ sent: true });
});
