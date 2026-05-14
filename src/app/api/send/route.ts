import { NextRequest, NextResponse } from "next/server";
import { apiHandler } from "@/lib/api-handler";
import { apiError, getClientIp } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { getPublicMonitoringSettings } from "@/lib/monitoring-settings";
import { checkRateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// Allowed URL patterns for the Umami proxy to prevent SSRF.
// Only permits HTTPS URLs (or localhost in dev) to known analytics paths.
function isAllowedUmamiUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const isDev = process.env.NODE_ENV === "development";
    if (!isDev && parsed.protocol !== "https:") return false;
    // Block requests to private/internal networks
    const hostname = parsed.hostname;
    if (
      hostname === "169.254.169.254" || // cloud metadata
      hostname === "localhost" ||
      hostname.startsWith("10.") ||
      hostname.startsWith("192.168.") ||
      hostname === "127.0.0.1" ||
      hostname === "[::1]" ||
      hostname === "0.0.0.0" ||
      hostname.endsWith(".internal") ||
      hostname.endsWith(".local") ||
      // 172.16.0.0/12 (172.16.x.x - 172.31.x.x)
      (hostname.startsWith("172.") &&
        (() => {
          const second = parseInt(hostname.split(".")[1] ?? "0", 10);
          return second >= 16 && second <= 31;
        })())
    ) {
      if (!isDev) return false;
    }
    return true;
  } catch {
    return false;
  }
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
    const upstream = await fetch(targetUrl, {
      method: "POST",
      headers: {
        "content-type":
          request.headers.get("content-type") || "application/json",
        "user-agent": request.headers.get("user-agent") || "healthlog-proxy",
      },
      body,
      cache: "no-store",
    });

    lastResponseStatus = upstream.status;

    // Try next candidate only for path misses.
    if (upstream.status === 404) {
      continue;
    }

    return new NextResponse(null, { status: upstream.status });
  }

  return new NextResponse(null, { status: lastResponseStatus });
});
