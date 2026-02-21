import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { apiSuccess, apiError } from "@/lib/api-response";

export const dynamic = "force-dynamic";

export async function GET() {
  const sessionData = await getSession();
  if (!sessionData) return apiError("Nicht angemeldet", 401);

  const user = await prisma.user.findUnique({
    where: { id: sessionData.user.id },
    select: {
      moodLogUrlEncrypted: true,
      moodLogEnabled: true,
      moodLogLastSyncedAt: true,
      moodLogWebhookSecret: true,
    },
  });

  const entryCount = await prisma.moodEntry.count({
    where: { userId: sessionData.user.id },
  });

  return apiSuccess({
    configured: Boolean(user?.moodLogUrlEncrypted),
    enabled: user?.moodLogEnabled ?? false,
    lastSyncedAt: user?.moodLogLastSyncedAt ?? null,
    entryCount,
    webhookSecret: user?.moodLogWebhookSecret ?? null,
  });
}
