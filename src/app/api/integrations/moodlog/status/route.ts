import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { readMoodLogSecret } from "@/lib/moodlog-secret";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "moodlog.status" } });

  const dbUser = await prisma.user.findUnique({
    where: { id: user.id },
    select: {
      moodLogUrlEncrypted: true,
      moodLogEnabled: true,
      moodLogLastSyncedAt: true,
      moodLogWebhookSecret: true,
    },
  });

  const entryCount = await prisma.moodEntry.count({
    // v1.7.0 sync — exclude tombstoned rows from the entry count.
    where: { userId: user.id, deletedAt: null },
  });

  // V3 audit STILL-V2-C-2: stored secret is now AES-GCM encrypted at rest.
  // Decrypt for the user's settings page; legacy plaintext is also handled.
  const webhookSecret = readMoodLogSecret(dbUser?.moodLogWebhookSecret ?? null);

  return apiSuccess({
    configured: Boolean(dbUser?.moodLogUrlEncrypted),
    enabled: dbUser?.moodLogEnabled ?? false,
    lastSyncedAt: dbUser?.moodLogLastSyncedAt ?? null,
    entryCount,
    webhookSecret,
  });
});
