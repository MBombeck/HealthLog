import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { apiSuccess, apiError } from "@/lib/api-response";
import { ntfySettingsSchema } from "@/lib/validations/notifications";
import { encrypt, decrypt } from "@/lib/crypto";
import { NextRequest } from "next/server";

/**
 * GET: Return current ntfy config (without auth token).
 * PUT: Update ntfy config.
 */
export async function GET() {
  const session = await getSession();
  if (!session) return apiError("Nicht angemeldet", 401);

  const channel = await prisma.notificationChannel.findUnique({
    where: {
      userId_type: { userId: session.user.id, type: "NTFY" },
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

  return apiSuccess({
    enabled: channel.enabled,
    serverUrl: config.serverUrl,
    topic: config.topic,
    hasAuthToken: !!config.authToken,
  });
}

export async function PUT(request: NextRequest) {
  const session = await getSession();
  if (!session) return apiError("Nicht angemeldet", 401);

  const body = await request.json();
  const parsed = ntfySettingsSchema.safeParse(body);
  if (!parsed.success) return apiError("Ungültige Daten", 422);

  const { serverUrl, topic, authToken, enabled } = parsed.data;

  if (enabled && (!serverUrl || !topic)) {
    return apiError(
      "Server-URL und Topic sind erforderlich, wenn ntfy aktiviert ist",
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
      userId_type: { userId: session.user.id, type: "NTFY" },
    },
    create: {
      userId: session.user.id,
      type: "NTFY",
      enabled,
      config: encryptedConfig,
    },
    update: {
      enabled,
      config: encryptedConfig,
    },
  });

  return apiSuccess({ saved: true });
}
