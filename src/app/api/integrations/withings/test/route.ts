import type { NextRequest } from "next/server";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess, apiError } from "@/lib/api-response";
import { checkRateLimit } from "@/lib/rate-limit";
import { annotate } from "@/lib/logging/context";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";

export const dynamic = "force-dynamic";

const WITHINGS_MEASURE_URL = "https://wbsapi.withings.net/measure";

function categorizeStatus(status: number): string {
  if (status === 401 || status === 403)
    return "Withings rejected the credentials";
  if (status === 429) return "Withings rate-limited the request";
  if (status >= 500) return "Withings returned a server error";
  return "Withings connection failed";
}

export const POST = apiHandler(async (_request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "integrations.withings.test" } });

  const rl = await checkRateLimit(`withings-test:${user.id}`, 5, 60_000);
  if (!rl.allowed) return apiError("Too many test requests", 429);

  const connection = await prisma.withingsConnection.findUnique({
    where: { userId: user.id },
  });
  if (!connection) {
    return apiError("Withings not connected", 422);
  }

  let accessToken: string;
  try {
    accessToken = decrypt(connection.accessToken);
  } catch {
    return apiError("Withings credentials unreadable", 422);
  }

  const params = new URLSearchParams({
    action: "getmeas",
    meastypes: "1",
    limit: "1",
  });

  const start = performance.now();
  try {
    const res = await fetch(WITHINGS_MEASURE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Bearer ${accessToken}`,
      },
      body: params.toString(),
    });
    const latencyMs = Math.round(performance.now() - start);

    if (!res.ok) {
      annotate({
        meta: {
          withings_test_status: res.status,
          withings_test_latency_ms: latencyMs,
        },
      });
      return apiError(categorizeStatus(res.status), 502);
    }

    let json: { status?: number } = {};
    try {
      json = (await res.json()) as { status?: number };
    } catch {
      // ignore — body parsing not critical for the test
    }

    if (json.status !== 0 && json.status !== undefined) {
      annotate({
        meta: {
          withings_test_api_status: json.status,
          withings_test_latency_ms: latencyMs,
        },
      });
      return apiError("Withings returned an error", 502);
    }

    return apiSuccess({
      ok: true,
      lastSyncedAt: connection.lastSyncedAt,
      latencyMs,
    });
  } catch (e) {
    const err = e as Error;
    annotate({
      meta: {
        withings_test_error: err.message.slice(0, 500),
      },
    });
    return apiError("Withings connection failed", 502);
  }
});
