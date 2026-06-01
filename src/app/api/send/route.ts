import { NextRequest, NextResponse } from "next/server";
import { apiHandler } from "@/lib/api-handler";
import { apiError, getClientIp } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { getPublicMonitoringSettings } from "@/lib/monitoring-settings";
import { checkRateLimit } from "@/lib/rate-limit";
import { isPublicUrl } from "@/lib/validations/notifications";
import { safeFetch } from "@/lib/safe-fetch";

export const dynamic = "force-dynamic";

// Use the canonical `isPublicUrl` guard rather than a hand-rolled
// allowlist. The previous local implementation predated the central
// helper and was missing CGNAT (100.64/10), IPv6 ULA (fc00::/7), the
// octal/hex/decimal IPv4 alt-notations, and the IPv4-mapped IPv6
// shapes — every one of which the shared helper catches. Dev mode is
// no longer special-cased here: a localhost-or-RFC1918 Umami URL was
// never a valid configuration anyway (the proxy ships the request to
// the configured host with the visitor's user-agent + body, which
// only makes sense against an externally-reachable analytics target).
function isAllowedUmamiUrl(url: string): boolean {
  return isPublicUrl(url);
}

function resolveUmamiSendUrls(scriptUrl: string | null): string[] {
  if (!scriptUrl) return [];
  try {
    const parsed = new URL(scriptUrl);
    const origin = parsed.origin;
    const pathSegments = parsed.pathname.split("/").filter(Boolean);
    const segments = [...pathSegments];

    // Remove script file segment (e.g. script.js, umami.js) if present.
    if (segments.length > 0 && segments[segments.length - 1]?.includes(".")) {
      segments.pop();
    }

    const prefix = segments.length > 0 ? `/${segments.join("/")}` : "";
    const candidates = [
      `${origin}${prefix}/api/send`,
      `${origin}/api/send`,
      `${origin}/umami/api/send`,
    ];

    return Array.from(new Set(candidates.filter(isAllowedUmamiUrl)));
  } catch {
    return [];
  }
}

export const POST = apiHandler(async (request: NextRequest) => {
  annotate({ action: { name: "umami.proxy" } });

  const ip = getClientIp(request) ?? "unknown";
  const rl = await checkRateLimit(`umami-proxy:${ip}`, 120, 60 * 1000);
  if (!rl.allowed) return apiError("Rate limit exceeded", 429);

  const settings = await getPublicMonitoringSettings();
  if (!settings.umamiEnabled) {
    return NextResponse.json({}, { status: 204 });
  }

  const targetUrls = resolveUmamiSendUrls(settings.umamiScriptUrl);
  if (targetUrls.length === 0 || !settings.umamiWebsiteId) {
    return NextResponse.json({}, { status: 204 });
  }

  const body = await request.arrayBuffer();
  // Limit proxy body size to 64 KB to prevent abuse
  if (body.byteLength > 65536) {
    return NextResponse.json({}, { status: 413 });
  }

  let lastResponseStatus = 404;

  for (const targetUrl of targetUrls) {
    const upstream = await safeFetch(
      targetUrl,
      {
        method: "POST",
        headers: {
          "content-type":
            request.headers.get("content-type") || "application/json",
          "user-agent": request.headers.get("user-agent") || "healthlog-proxy",
        },
        body,
        cache: "no-store",
      },
      // Operator-configured Umami host — pin the connect-time IP.
      { requirePublicHost: true },
    );

    lastResponseStatus = upstream.status;

    // Try next candidate only for path misses.
    if (upstream.status === 404) {
      continue;
    }

    return new NextResponse(null, { status: upstream.status });
  }

  return new NextResponse(null, { status: lastResponseStatus });
});
