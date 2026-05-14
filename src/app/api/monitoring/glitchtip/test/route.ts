import type { NextRequest } from "next/server";
import { apiHandler, requireAdmin } from "@/lib/api-handler";
import { apiSuccess, apiError } from "@/lib/api-response";
import { checkRateLimit } from "@/lib/rate-limit";
import { annotate } from "@/lib/logging/context";
import { prisma } from "@/lib/db";
import { sendGlitchtipEvent } from "@/lib/monitoring/glitchtip";
import { isPublicUrl } from "@/lib/validations/notifications";

export const dynamic = "force-dynamic";

const TIMEOUT_MS = 5_000;

export const POST = apiHandler(async (request: NextRequest) => {
  void request;
  const { user } = await requireAdmin();
  annotate({ action: { name: "monitoring.glitchtip.test" } });

  const rl = await checkRateLimit(`glitchtip-test:${user.id}`, 5, 60_000);
  if (!rl.allowed) {
    return apiError("Too many test requests", 429, {
      errorCode: "rate_limited_self",
    });
  }

  const settings = await prisma.appSettings.findUnique({
    where: { id: "singleton" },
    select: { glitchtipDsn: true },
  });

  if (!settings?.glitchtipDsn) {
    return apiError("Glitchtip DSN not configured", 422, {
      errorCode: "not_configured",
    });
  }

  // DSN is admin-set, but a compromised/social-engineered admin (or a stored
  // settings record from a hostile import) could aim Glitchtip at internal
  // hosts. Validate the host is publicly reachable and uses HTTPS before we
  // hand the URL to the helper.
  let dsnHost: string;
  try {
    const parsed = new URL(settings.glitchtipDsn);
    if (parsed.protocol !== "https:") {
      return apiError("Glitchtip DSN must use HTTPS", 422, {
        errorCode: "dsn_not_https",
      });
    }
    if (!isPublicUrl(`${parsed.protocol}//${parsed.host}`)) {
      return apiError("Glitchtip DSN host is not publicly reachable", 422, {
        errorCode: "dsn_host_not_public",
      });
    }
    dsnHost = parsed.host;
  } catch {
    return apiError("Glitchtip DSN is malformed", 422, {
      errorCode: "dsn_invalid",
    });
  }

  const start = performance.now();
  const send = sendGlitchtipEvent({
    dsn: settings.glitchtipDsn,
    input: {
      environment: process.env.NODE_ENV ?? "production",
      message: "HealthLog Glitchtip self-test",
      level: "info",
      // sourceTag rides through into the event tags. Adding "noise: true" lets
      // operators silence these in their inbound Glitchtip rules so the test
      // button doesn't pollute the issue inbox.
      sourceTag: "self-test:noise",
    },
  });

  const timeoutErr = new Error("timeout");
  timeoutErr.name = "AbortError";
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(timeoutErr), TIMEOUT_MS),
  );

  try {
    const result = await Promise.race([send, timeout]);
    const latencyMs = Math.round(performance.now() - start);

    if (!result.ok) {
      annotate({
        meta: {
          glitchtip_test_status: result.status ?? null,
          glitchtip_test_method: result.method ?? null,
          glitchtip_test_latency_ms: latencyMs,
          glitchtip_test_host: dsnHost,
        },
      });
      return apiError("Glitchtip rejected the event", 502, {
        errorCode: "upstream_error",
      });
    }

    return apiSuccess({
      ok: true,
      statusCode: result.status ?? 200,
      latencyMs,
    });
  } catch (e) {
    const err = e as Error;
    const isTimeout = err.name === "AbortError";
    const code = isTimeout ? "timeout" : "connection_failed";
    annotate({
      meta: {
        glitchtip_test_code: code,
        glitchtip_test_host: dsnHost,
        glitchtip_test_error: err.message.slice(0, 200),
      },
    });
    return apiError(
      isTimeout ? "Glitchtip request timed out" : "Glitchtip connection failed",
      502,
      { errorCode: code },
    );
  }
});
