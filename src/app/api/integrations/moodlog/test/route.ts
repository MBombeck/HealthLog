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

function categoriseHttpStatus(status: number): {
  code: string;
  message: string;
} {
  if (status === 401 || status === 403) {
    return {
      code: "credentials_rejected",
      message: "moodLog rejected the API key",
    };
  }
  if (status === 404) {
    return {
      code: "endpoint_not_found",
      message: "moodLog endpoint not found at the configured URL",
    };
  }
  if (status === 429) {
    return {
      code: "rate_limited",
      message: "moodLog rate-limited the request",
    };
  }
  if (status >= 500) {
    return {
      code: "upstream_error",
      message: "moodLog returned a server error",
    };
  }
  return { code: "connection_failed", message: "moodLog connection failed" };
}

function redact(text: string): string {
  return text
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/https?:\/\/\S+/gi, "[url]");
}

export const POST = apiHandler(async (request: NextRequest) => {
  void request;
  const { user } = await requireAuth();
  annotate({ action: { name: "integrations.moodlog.test" } });

  const rl = await checkRateLimit(`moodlog-test:${user.id}`, 5, 60_000);
  if (!rl.allowed) {
    return apiError("Too many test requests", 429, {
      errorCode: "rate_limited_self",
    });
  }

  const dbUser = await prisma.user.findUnique({
    where: { id: user.id },
    select: {
      moodLogUrlEncrypted: true,
      moodLogApiKeyEncrypted: true,
      moodLogLastSyncedAt: true,
    },
  });

  if (!dbUser?.moodLogUrlEncrypted || !dbUser.moodLogApiKeyEncrypted) {
    return apiError("moodLog not configured", 422, {
      errorCode: "not_configured",
    });
  }

  let baseUrl: string;
  let apiKey: string;
  try {
    baseUrl = decrypt(dbUser.moodLogUrlEncrypted);
    apiKey = decrypt(dbUser.moodLogApiKeyEncrypted);
  } catch {
    return apiError("moodLog credentials unreadable", 422, {
      errorCode: "credentials_unreadable",
    });
  }

  if (!isPublicUrl(baseUrl)) {
    return apiError("moodLog URL must be a public HTTP(S) endpoint", 422, {
      errorCode: "url_not_public",
    });
  }

  // Probe the actual sync endpoint with the actual auth header — a HEAD on the
  // bare URL would return 200 from the static landing page even if the API key
  // is invalid. Use a 1-day window to keep the upstream payload small.
  let probeUrl: URL;
  try {
    probeUrl = new URL("/api/integrations/health-log/mood", baseUrl);
  } catch {
    return apiError("moodLog URL is invalid", 422, {
      errorCode: "url_invalid",
    });
  }
  const yesterday = new Date(Date.now() - 24 * 3600 * 1000)
    .toISOString()
    .slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  probeUrl.searchParams.set("from", yesterday);
  probeUrl.searchParams.set("to", today);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const start = performance.now();

  try {
    const res = await fetch(probeUrl.toString(), {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
      cache: "no-store",
      // `manual` neutralises the redirect-follow SSRF where a public host
      // serves a 302 to 169.254.169.254 (cloud metadata) or RFC1918 ranges.
      redirect: "manual",
    });
    const latencyMs = Math.round(performance.now() - start);

    // 3xx in `manual` redirect mode → we never followed; treat as success
    // failure rather than chase the Location header.
    if (res.status >= 300 && res.status < 400) {
      annotate({ meta: { moodlog_test_status: res.status } });
      return apiError("moodLog redirected — check the configured URL", 502, {
        errorCode: "redirected",
      });
    }

    if (!res.ok) {
      const cat = categoriseHttpStatus(res.status);
      annotate({
        meta: {
          moodlog_test_status: res.status,
          moodlog_test_code: cat.code,
          moodlog_test_latency_ms: latencyMs,
        },
      });
      return apiError(cat.message, 502, { errorCode: cat.code });
    }

    return apiSuccess({
      ok: true,
      statusCode: res.status,
      latencyMs,
      lastSyncedAt: dbUser.moodLogLastSyncedAt,
    });
  } catch (e) {
    const err = e as Error;
    const isAbort = err.name === "AbortError";
    const code = isAbort ? "timeout" : "connection_failed";
    annotate({
      meta: {
        moodlog_test_code: code,
        moodlog_test_error: redact(err.message).slice(0, 300),
      },
    });
    return apiError(
      isAbort ? "moodLog request timed out" : "moodLog connection failed",
      502,
      { errorCode: code },
    );
  } finally {
    clearTimeout(timer);
  }
});
