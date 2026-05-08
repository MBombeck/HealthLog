import type { NextRequest } from "next/server";
import { apiHandler, requireAdmin } from "@/lib/api-handler";
import { apiSuccess, apiError } from "@/lib/api-response";
import { checkRateLimit } from "@/lib/rate-limit";
import { annotate } from "@/lib/logging/context";
import { prisma } from "@/lib/db";
import { sendGlitchtipEvent } from "@/lib/monitoring/glitchtip";

export const dynamic = "force-dynamic";

export const POST = apiHandler(async (_request: NextRequest) => {
  const { user } = await requireAdmin();
  annotate({ action: { name: "monitoring.glitchtip.test" } });

  const rl = await checkRateLimit(`glitchtip-test:${user.id}`, 5, 60_000);
  if (!rl.allowed) return apiError("Too many test requests", 429);

  const settings = await prisma.appSettings.findUnique({
    where: { id: "default" },
    select: { glitchtipDsn: true },
  });

  if (!settings?.glitchtipDsn) {
    return apiError("Glitchtip DSN not configured", 422);
  }

  try {
    const result = await sendGlitchtipEvent({
      dsn: settings.glitchtipDsn,
      input: {
        environment: process.env.NODE_ENV ?? "production",
        message: "HealthLog Glitchtip self-test",
        level: "info",
        sourceTag: "self-test",
      },
    });

    if (!result.ok) {
      annotate({
        meta: {
          glitchtip_test_status: result.status ?? null,
          glitchtip_test_method: result.method ?? null,
        },
      });
      return apiError("Glitchtip rejected the event", 502);
    }

    return apiSuccess({
      ok: true,
      statusCode: result.status ?? 200,
    });
  } catch (e) {
    const err = e as Error;
    annotate({
      meta: { glitchtip_test_error: err.message.slice(0, 500) },
    });
    return apiError("Glitchtip connection failed", 502);
  }
});
