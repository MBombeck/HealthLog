import type { NextRequest } from "next/server";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess, apiError } from "@/lib/api-response";
import { checkRateLimit } from "@/lib/rate-limit";
import { annotate } from "@/lib/logging/context";
import { prisma } from "@/lib/db";
import { getValidToken } from "@/lib/withings/sync";

export const dynamic = "force-dynamic";

const WITHINGS_MEASURE_URL = "https://wbsapi.withings.net/measure";
const TIMEOUT_MS = 5_000;

type CategorisedError = { code: string; message: string };

function categoriseHttpStatus(status: number): CategorisedError {
  if (status === 401 || status === 403) {
    return {
      code: "credentials_rejected",
      message: "Withings rejected the credentials",
    };
  }
  if (status === 429) {
    return {
      code: "rate_limited",
      message: "Withings rate-limited the request",
    };
  }
  if (status >= 500) {
    return {
      code: "upstream_error",
      message: "Withings returned a server error",
    };
  }
  return { code: "connection_failed", message: "Withings connection failed" };
}

// Withings returns HTTP 200 with `status` in the JSON body to signal API-level
// errors. Reference: https://developer.withings.com/api-reference/#section/Response-status
function categoriseApiStatus(apiStatus: number): CategorisedError {
  switch (apiStatus) {
    case 100:
    case 101:
    case 102:
    case 401:
      return {
        code: "credentials_rejected",
        message: "Withings rejected the credentials",
      };
    case 601:
      return {
        code: "rate_limited",
        message: "Withings rate-limited the request",
      };
    case 503:
      return {
        code: "upstream_error",
        message: "Withings reported a temporary server error",
      };
    default:
      return {
        code: "upstream_error",
        message: "Withings returned an error",
      };
  }
}

export const POST = apiHandler(async (_request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "integrations.withings.test" } });

  const rl = await checkRateLimit(`withings-test:${user.id}`, 5, 60_000);
  if (!rl.allowed) {
    return apiError("Too many test requests", 429, {
      errorCode: "rate_limited_self",
    });
  }

  const tokenInfo = await getValidToken(user.id);
  if (!tokenInfo) {
    return apiError("Withings not connected", 422, {
      errorCode: "not_configured",
    });
  }

  const connection = await prisma.withingsConnection.findUnique({
    where: { userId: user.id },
    select: { lastSyncedAt: true },
  });

  const params = new URLSearchParams({
    action: "getmeas",
    meastypes: "1",
    lastupdate: Math.floor(Date.now() / 1000 - 60).toString(),
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const start = performance.now();

  try {
    const res = await fetch(WITHINGS_MEASURE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Bearer ${tokenInfo.accessToken}`,
      },
      body: params.toString(),
      signal: controller.signal,
      redirect: "manual",
    });
    const latencyMs = Math.round(performance.now() - start);

    if (!res.ok) {
      const cat = categoriseHttpStatus(res.status);
      annotate({
        meta: {
          withings_test_status: res.status,
          withings_test_code: cat.code,
          withings_test_latency_ms: latencyMs,
        },
      });
      return apiError(cat.message, 502, { errorCode: cat.code });
    }

    let json: { status?: number } = {};
    try {
      json = (await res.json()) as { status?: number };
    } catch {
      annotate({
        meta: { withings_test_code: "upstream_invalid_json" },
      });
      return apiError("Withings returned an unparseable response", 502, {
        errorCode: "upstream_invalid_json",
      });
    }

    if (json.status !== 0) {
      const apiStatus = json.status ?? -1;
      const cat = categoriseApiStatus(apiStatus);
      annotate({
        meta: {
          withings_test_api_status: apiStatus,
          withings_test_code: cat.code,
          withings_test_latency_ms: latencyMs,
        },
      });
      return apiError(cat.message, 502, { errorCode: cat.code });
    }

    return apiSuccess({
      ok: true,
      lastSyncedAt: connection?.lastSyncedAt ?? null,
      latencyMs,
    });
  } catch (e) {
    const err = e as Error;
    const isAbort = err.name === "AbortError";
    const code = isAbort ? "timeout" : "connection_failed";
    annotate({
      meta: {
        withings_test_code: code,
        withings_test_error: redact(err.message).slice(0, 300),
      },
    });
    return apiError(
      isAbort ? "Withings request timed out" : "Withings connection failed",
      502,
      { errorCode: code },
    );
  } finally {
    clearTimeout(timer);
  }
});

// Strip any `Bearer <token>` substring before annotating; the catch path can
// see DNS / TLS errors that include the request init via err.cause in some
// runtimes, and we never want a token in Loki.
function redact(text: string): string {
  return text.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
}
