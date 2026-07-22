import { prisma } from "@/lib/db";
import { apiSuccess, apiError, safeJson } from "@/lib/api-response";
import {
  notificationChannelEnabledSchema,
  ntfySettingsSchema,
} from "@/lib/validations/notifications";
import { encrypt, decrypt } from "@/lib/crypto";
import { NextRequest } from "next/server";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";

/**
 * GET: Return current ntfy config (without auth token).
 * PUT: Update ntfy config.
 */
export const GET = apiHandler(async () => {
  const { user } = await requireAuth();

  const channel = await prisma.notificationChannel.findUnique({
    where: {
      userId_type: { userId: user.id, type: "NTFY" },
    },
  });

  if (!channel) {
    return apiSuccess({
      enabled: false,
      serverUrl: "https://ntfy.sh",
      topic: "",
      hasAuthToken: false,
    });
  }

  const config = JSON.parse(decrypt(channel.config)) as {
    serverUrl: string;
    topic: string;
    authToken?: string;
  };

  annotate({ action: { name: "settings.ntfy.get" } });

  return apiSuccess({
    enabled: channel.enabled,
    serverUrl: config.serverUrl,
    topic: config.topic,
    hasAuthToken: !!config.authToken,
  });
});

export const PUT = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: 64 * 1024,
  });

  if (jsonError) return jsonError;

  const enabledOnly = notificationChannelEnabledSchema.safeParse(body);
  if (enabledOnly.success) {
    const { enabled } = enabledOnly.data;

    if (enabled) {
      const existing = await prisma.notificationChannel.findUnique({
        where: { userId_type: { userId: user.id, type: "NTFY" } },
      });

      let isConfigured = false;
      if (existing) {
        try {
          const config = JSON.parse(decrypt(existing.config)) as {
            serverUrl?: string;
            topic?: string;
          };
          isConfigured = !!config.serverUrl && !!config.topic;
        } catch {
          isConfigured = false;
        }
      }

      if (!isConfigured) {
        return apiError(
          "Server URL and topic are required when ntfy is enabled",
          422,
        );
      }
    }

    const result = await prisma.notificationChannel.updateMany({
      where: { userId: user.id, type: "NTFY" },
      data: { enabled },
    });
    if (enabled && result.count === 0) {
      return apiError(
        "Server URL and topic are required when ntfy is enabled",
        422,
      );
    }

    annotate({ action: { name: "settings.ntfy.update" }, meta: { enabled } });
    return apiSuccess({ saved: true });
  }

  const parsed = ntfySettingsSchema.safeParse(body);
  if (!parsed.success) return apiError("Invalid data", 422);

  const { serverUrl, topic, authToken, enabled } = parsed.data;

  if (enabled && (!serverUrl || !topic)) {
    return apiError(
      "Server URL and topic are required when ntfy is enabled",
      422,
    );
  }

  const config = JSON.stringify({
    serverUrl: serverUrl || "https://ntfy.sh",
    topic: topic || "",
    ...(authToken ? { authToken } : {}),
  });

  const encryptedConfig = encrypt(config);

  await prisma.notificationChannel.upsert({
    where: {
      userId_type: { userId: user.id, type: "NTFY" },
    },
    create: {
      userId: user.id,
      type: "NTFY",
      enabled,
      config: encryptedConfig,
    },
    update: {
      enabled,
      config: encryptedConfig,
    },
  });

  annotate({ action: { name: "settings.ntfy.update" }, meta: { enabled } });

  return apiSuccess({ saved: true });
});
