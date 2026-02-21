import { NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { apiSuccess, apiError } from "@/lib/api-response";
import { encrypt } from "@/lib/crypto";
import { moodLogCredentialsSchema } from "@/lib/validations/moodlog";

export const dynamic = "force-dynamic";

export async function PUT(request: NextRequest) {
  const sessionData = await getSession();
  if (!sessionData) return apiError("Nicht angemeldet", 401);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError("Invalid JSON", 400);
  }

  const parsed = moodLogCredentialsSchema.safeParse(body);
  if (!parsed.success) {
    return apiError("Ungültige Eingabe", 422);
  }

  const { url, apiKey } = parsed.data;

  // Generate webhook secret if not yet set
  const existing = await prisma.user.findUnique({
    where: { id: sessionData.user.id },
    select: { moodLogWebhookSecret: true },
  });

  const webhookSecret =
    existing?.moodLogWebhookSecret ??
    `mb_${randomBytes(32).toString("hex")}`;

  await prisma.user.update({
    where: { id: sessionData.user.id },
    data: {
      moodLogUrlEncrypted: encrypt(url),
      moodLogApiKeyEncrypted: encrypt(apiKey),
      moodLogEnabled: true,
      moodLogWebhookSecret: webhookSecret,
    },
  });

  return apiSuccess({
    configured: true,
    enabled: true,
    webhookSecret,
  });
}

export async function DELETE() {
  const sessionData = await getSession();
  if (!sessionData) return apiError("Nicht angemeldet", 401);

  // Delete all mood entries for this user
  await prisma.moodEntry.deleteMany({
    where: { userId: sessionData.user.id },
  });

  // Clear credentials
  await prisma.user.update({
    where: { id: sessionData.user.id },
    data: {
      moodLogUrlEncrypted: null,
      moodLogApiKeyEncrypted: null,
      moodLogEnabled: false,
      moodLogLastSyncedAt: null,
      moodLogWebhookSecret: null,
    },
  });

  return apiSuccess({ disconnected: true });
}
