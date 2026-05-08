import type { NextRequest } from "next/server";
import { apiHandler, requireAdmin } from "@/lib/api-handler";
import { apiSuccess, apiError } from "@/lib/api-response";
import { checkRateLimit } from "@/lib/rate-limit";
import { annotate } from "@/lib/logging/context";
import { prisma } from "@/lib/db";
import { isPublicUrl } from "@/lib/validations/notifications";

export const dynamic = "force-dynamic";

const TIMEOUT_MS = 5_000;
const MAX_BODY_BYTES = 256 * 1024;

function redact(text: string): string {
  return text.replace(/https?:\/\/\S+/gi, "[url]");
}

export const POST = apiHandler(async (_request: NextRequest) => {
  const { user } = await requireAdmin();
  annotate({ action: { name: "monitoring.umami.test" } });

  const rl = await checkRateLimit(`umami-test:${user.id}`, 5, 60_000);
  if (!rl.allowed) {
    return apiError("Too many test requests", 429, {
      errorCode: "rate_limited_self",
    });
  }

  const settings = await prisma.appSettings.findUnique({
    where: { id: "singleton" },
    select: { umamiScriptUrl: true },
  });

  if (!settings?.umamiScriptUrl) {
    return apiError("Umami script URL not configured", 422, {
      errorCode: "not_configured",
    });
  }

  const url = settings.umamiScriptUrl;
  if (!isPublicUrl(url) || !url.startsWith("https://")) {
    return apiError("Umami URL must be a public HTTPS endpoint", 422, {
      errorCode: "url_not_public",
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const start = performance.now();

  try {
    const res = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      cache: "no-store",
      // `manual` neutralises a redirect-follow SSRF — even though the URL was
      // checked with isPublicUrl(), a public host can 302 to a private IP.
      redirect: "manual",
    });
    const latencyMs = Math.round(performance.now() - start);

    if (res.status >= 300 && res.status < 400) {
      annotate({ meta: { umami_test_status: res.status } });
      return apiError("Umami URL redirects — check configuration", 502, {
        errorCode: "redirected",
      });
    }

    // Cap response read to 256 KB so a hostile public server can't stream
    // gigabytes through us; combined with the 5 s abort, RAM use stays bounded.
    let body = "";
    if (res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let total = 0;
      try {
        while (total < MAX_BODY_BYTES) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          body += decoder.decode(value, { stream: true });
        }
        body += decoder.decode();
      } finally {
        reader.releaseLock();
      }
    }

    if (!res.ok) {
      annotate({
        meta: {
          umami_test_status: res.status,
          umami_test_latency_ms: latencyMs,
        },
      });
      return apiError("Umami connection failed", 502, {
        errorCode: "upstream_error",
      });
    }

    // Look for tracker-shape signal rather than a literal "umami" substring —
    // a 404 page that mentions "Powered by Umami" would otherwise slip through.
    const hasMarker = /umami\.track|window\.umami|"umami"/i.test(body);

    return apiSuccess({
      ok: hasMarker,
      statusCode: res.status,
      latencyMs,
      hasMarker,
    });
  } catch (e) {
    const err = e as Error;
    const isAbort = err.name === "AbortError";
    const code = isAbort ? "timeout" : "connection_failed";
    annotate({
      meta: {
        umami_test_code: code,
        umami_test_error: redact(err.message).slice(0, 300),
      },
    });
    return apiError(
      isAbort ? "Umami request timed out" : "Umami connection failed",
      502,
      { errorCode: code },
    );
  } finally {
    clearTimeout(timer);
  }
});
