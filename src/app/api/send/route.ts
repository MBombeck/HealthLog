import { NextRequest, NextResponse } from "next/server";
import { getPublicMonitoringSettings } from "@/lib/monitoring-settings";

export const dynamic = "force-dynamic";

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

    return Array.from(new Set(candidates));
  } catch {
    return [];
  }
}

export async function POST(request: NextRequest) {
  const settings = await getPublicMonitoringSettings();
  if (!settings.umamiEnabled) {
    return NextResponse.json({}, { status: 204 });
  }

  const targetUrls = resolveUmamiSendUrls(settings.umamiScriptUrl);
  if (targetUrls.length === 0 || !settings.umamiWebsiteId) {
    return NextResponse.json({}, { status: 204 });
  }

  const body = await request.arrayBuffer();

  try {
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
  } catch (error) {
    console.error("Umami send proxy failed:", error);
    return new NextResponse(null, { status: 502 });
  }
}
