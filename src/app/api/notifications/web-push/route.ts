import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { apiSuccess, apiError } from "@/lib/api-response";
import { encrypt } from "@/lib/crypto";
import { z } from "zod/v4";

const subscribeSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
});

const unsubscribeSchema = z.object({
  endpoint: z.string().url(),
});

/**
 * POST /api/notifications/web-push
 * Save a Web Push subscription for the current user.
 */
export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) return apiError("Nicht angemeldet", 401);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError("Ungültige JSON-Daten", 422);
  }

  const parsed = subscribeSchema.safeParse(body);
  if (!parsed.success) return apiError("Ungültige Daten", 422);

  const { endpoint, keys } = parsed.data;
  const userAgent = request.headers.get("user-agent") ?? undefined;

  // Upsert subscription (encrypt sensitive keys)
  await prisma.pushSubscription.upsert({
    where: {
      userId_endpoint: {
        userId: session.user.id,
        endpoint,
      },
    },
    create: {
      userId: session.user.id,
      endpoint,
      p256dh: encrypt(keys.p256dh),
      auth: encrypt(keys.auth),
      userAgent,
    },
    update: {
      p256dh: encrypt(keys.p256dh),
      auth: encrypt(keys.auth),
      userAgent,
    },
  });

  // Ensure a WEB_PUSH notification channel exists for this user
  const existingChannel = await prisma.notificationChannel.findFirst({
    where: { userId: session.user.id, type: "WEB_PUSH" },
  });

  if (!existingChannel) {
    await prisma.notificationChannel.create({
      data: {
        userId: session.user.id,
        type: "WEB_PUSH",
        enabled: true,
        config: encrypt(JSON.stringify({})),
      },
    });
  }

  return apiSuccess({ subscribed: true });
}

/**
 * DELETE /api/notifications/web-push
 * Remove a Web Push subscription.
 */
export async function DELETE(request: NextRequest) {
  const session = await getSession();
  if (!session) return apiError("Nicht angemeldet", 401);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError("Ungültige JSON-Daten", 422);
  }

  const parsed = unsubscribeSchema.safeParse(body);
  if (!parsed.success) return apiError("Ungültige Daten", 422);

  await prisma.pushSubscription.deleteMany({
    where: {
      userId: session.user.id,
      endpoint: parsed.data.endpoint,
    },
  });

  return apiSuccess({ unsubscribed: true });
}
