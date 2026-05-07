import { NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";
import { apiSuccess, apiError } from "@/lib/api-response";
import { encrypt } from "@/lib/crypto";
import {
  encryptMoodLogSecret,
  readMoodLogSecret,
} from "@/lib/moodlog-secret";
import { moodLogCredentialsSchema } from "@/lib/validations/moodlog";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";

export const dynamic = "force-dynamic";

export const PUT = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError("Invalid JSON", 400);
  }

  const parsed = moodLogCredentialsSchema.safeParse(body);
  if (!parsed.success) {
    return apiError("Invalid input", 422);
  }

  const { url, apiKey } = parsed.data;

  // Generate webhook secret if not yet set; otherwise reuse the existing
  // one (decrypted from at-rest storage; legacy plaintext is also handled).
  const existing = await prisma.user.findUnique({
    where: { id: user.id },
    select: { moodLogWebhookSecret: true },
  });

  const webhookSecret =
    readMoodLogSecret(existing?.moodLogWebhookSecret ?? null) ??
    `mb_${randomBytes(32).toString("hex")}`;

  await prisma.user.update({
    where: { id: user.id },
    data: {
      moodLogUrlEncrypted: encrypt(url),
      moodLogApiKeyEncrypted: encrypt(apiKey),
      moodLogEnabled: true,
      // V3 audit STILL-V2-C-2: encrypt at rest with AES-256-GCM. A legacy
      // plaintext value (rare) is rotated to the encrypted form on this
      // write transparently.
      moodLogWebhookSecret: encryptMoodLogSecret(webhookSecret),
    },
  });

  annotate({ action: { name: "settings.moodlog.update" } });

  return apiSuccess({
    configured: true,
    enabled: true,
    webhookSecret,
  });
});

export const DELETE = apiHandler(async () => {
  const { user } = await requireAuth();

  // Delete all mood entries for this user
  await prisma.moodEntry.deleteMany({
    where: { userId: user.id },
  });

  // Clear credentials
  await prisma.user.update({
    where: { id: user.id },
    data: {
      moodLogUrlEncrypted: null,
      moodLogApiKeyEncrypted: null,
      moodLogEnabled: false,
      moodLogLastSyncedAt: null,
      moodLogWebhookSecret: null,
    },
  });

  annotate({ action: { name: "settings.moodlog.disconnect" } });

  return apiSuccess({ disconnected: true });
});
