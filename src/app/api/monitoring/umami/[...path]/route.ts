import { NextRequest, NextResponse } from "next/server";
import { apiHandler } from "@/lib/api-handler";
import { apiError, getClientIp } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { getPublicMonitoringSettings } from "@/lib/monitoring-settings";
import {
  resolveUmamiCollectPath,
  resolveUmamiSendUrls,
} from "@/lib/monitoring/umami";
import { checkRateLimit } from "@/lib/rate-limit";
import { safeFetch } from "@/lib/safe-fetch";

export const dynamic = "force-dynamic";

/** An empty answer: a refused event must not cost the tracker a 404 page. */
function empty(status: number): NextResponse {
  return new NextResponse(null, { status });
}

/**
 * Same-origin proxy for the browser's Umami tracker.
 *
 * The tracker is loaded with `data-host-url` set to `UMAMI_PROXY_PREFIX`, so
 * it posts to `<prefix><collect path>`, where the collect path is whatever
 * the operator's Umami build calls its endpoint (`/api/send` by default).
 * The path after the prefix must be exactly the collect path compiled into
 * the configured tracker; anything else is refused, so the proxy forwards
 * events and nothing else to the operator's host.
 */
export const POST = apiHandler(
  async (
    request: NextRequest,
    context: { params: Promise<{ path: string[] }> },
  ) => {
    annotate({ action: { name: "umami.proxy" } });

    const ip = getClientIp(request) ?? "unknown";
    const rl = await checkRateLimit(`umami-proxy:${ip}`, 120, 60 * 1000);
    if (!rl.allowed) return apiError("Rate limit exceeded", 429);

    const settings = await getPublicMonitoringSettings();
    if (
      !settings.umamiEnabled ||
      !settings.umamiScriptUrl ||
      !settings.umamiWebsiteId
    ) {
      return empty(204);
    }

    const { path } = await context.params;
    const requested = `/${path.join("/")}`;
    const collectPath = await resolveUmamiCollectPath(settings.umamiScriptUrl);
    if (collectPath === null) {
      annotate({
        action: { name: "umami.proxy.script_unavailable" },
      });
      return empty(502);
    }
    if (requested !== collectPath) {
      annotate({
        action: { name: "umami.proxy.path_refused" },
        meta: { requested: requested.slice(0, 128), collectPath },
      });
      return empty(404);
    }

    const targetUrls = resolveUmamiSendUrls(
      settings.umamiScriptUrl,
      collectPath,
    );
    if (targetUrls.length === 0) return empty(204);

    const body = await request.arrayBuffer();
    // Cap the proxied body at 64 KB.
    if (body.byteLength > 65536) return empty(413);

    let lastStatus = 404;
    for (const targetUrl of targetUrls) {
      let upstream: Response;
      try {
        upstream = await safeFetch(
          targetUrl,
          {
            method: "POST",
            headers: {
              "content-type":
                request.headers.get("content-type") || "application/json",
              "user-agent":
                request.headers.get("user-agent") || "healthlog-proxy",
            },
            body,
            cache: "no-store",
          },
          // Operator-configured Umami host: pin the connect-time IP.
          { requirePublicHost: true },
        );
      } catch {
        annotate({ action: { name: "umami.proxy.upstream_failed" } });
        return empty(502);
      }
      lastStatus = upstream.status;
      // Only a path miss moves on to the next candidate.
      if (upstream.status !== 404) return empty(upstream.status);
    }
    return empty(lastStatus);
  },
);
