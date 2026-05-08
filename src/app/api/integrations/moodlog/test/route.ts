import type { NextRequest } from "next/server";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess, apiError } from "@/lib/api-response";
import { checkRateLimit } from "@/lib/rate-limit";
import { annotate } from "@/lib/logging/context";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { isPublicUrl } from "@/lib/validations/notifications";

export const dynamic = "force-dynamic";

const TIMEOUT_MS = 5_000;

export const POST = apiHandler(async (_request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "integrations.moodlog.test" } });

  const rl = await checkRateLimit(`moodlog-test:${user.id}`, 5, 60_000);
  if (!rl.allowed) return apiError("Too many test requests", 429);

  const dbUser = await prisma.user.findUnique({
    where: { id: user.id },
    select: {
      moodLogUrlEncrypted: true,
      moodLogLastSyncedAt: true,
    },
  });

  if (!dbUser?.moodLogUrlEncrypted) {
    return apiError("moodLog URL not configured", 422);
  }

  let url: string;
  try {
    url = decrypt(dbUser.moodLogUrlEncrypted);
  } catch {
    return apiError("moodLog URL unreadable", 422);
  }

  if (!isPublicUrl(url)) {
    return apiError("moodLog URL is not a public HTTPS endpoint", 422);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: "HEAD",
      signal: controller.signal,
      cache: "no-store",
    });

    return apiSuccess({
      ok: res.ok,
      statusCode: res.status,
      lastSyncedAt: dbUser.moodLogLastSyncedAt,
    });
  } catch (e) {
    const err = e as Error;
    annotate({
      meta: {
        moodlog_test_error: err.message.slice(0, 500),
      },
    });
    return apiError("moodLog connection failed", 502);
  } finally {
    clearTimeout(timer);
  }
});
