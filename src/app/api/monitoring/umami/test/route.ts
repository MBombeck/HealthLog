import type { NextRequest } from "next/server";
import { apiHandler, requireAdmin } from "@/lib/api-handler";
import { apiSuccess, apiError } from "@/lib/api-response";
import { checkRateLimit } from "@/lib/rate-limit";
import { annotate } from "@/lib/logging/context";
import { prisma } from "@/lib/db";
import { isPublicUrl } from "@/lib/validations/notifications";

export const dynamic = "force-dynamic";

const TIMEOUT_MS = 5_000;

export const POST = apiHandler(async (_request: NextRequest) => {
  const { user } = await requireAdmin();
  annotate({ action: { name: "monitoring.umami.test" } });

  const rl = await checkRateLimit(`umami-test:${user.id}`, 5, 60_000);
  if (!rl.allowed) return apiError("Too many test requests", 429);

  const settings = await prisma.appSettings.findUnique({
    where: { id: "default" },
    select: { umamiScriptUrl: true },
  });

  if (!settings?.umamiScriptUrl) {
    return apiError("Umami script URL not configured", 422);
  }

  const url = settings.umamiScriptUrl;
  if (!isPublicUrl(url) || !url.startsWith("https://")) {
    return apiError("Umami URL must be a public HTTPS endpoint", 422);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      cache: "no-store",
    });

    let body = "";
    try {
      body = await res.text();
    } catch {
      body = "";
    }

    const hasMarker = /umami/i.test(body);

    if (!res.ok) {
      annotate({
        meta: { umami_test_status: res.status },
      });
      return apiError("Umami connection failed", 502);
    }

    return apiSuccess({
      ok: hasMarker,
      statusCode: res.status,
      hasMarker,
    });
  } catch (e) {
    const err = e as Error;
    annotate({
      meta: { umami_test_error: err.message.slice(0, 500) },
    });
    return apiError("Umami connection failed", 502);
  } finally {
    clearTimeout(timer);
  }
});
