import { NextRequest, NextResponse } from "next/server";
import { getPublicMonitoringSettings } from "@/lib/monitoring-settings";

export const dynamic = "force-dynamic";

function resolveUmamiSendUrl(scriptUrl: string | null): string | null {
  if (!scriptUrl) return null;
  try {
    const origin = new URL(scriptUrl).origin;
    return `${origin}/api/send`;
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest) {
  const settings = await getPublicMonitoringSettings();
  if (!settings.umamiEnabled) {
    return NextResponse.json({}, { status: 204 });
  }

  const targetUrl = resolveUmamiSendUrl(settings.umamiScriptUrl);
  if (!targetUrl || !settings.umamiWebsiteId) {
    return NextResponse.json({}, { status: 204 });
  }

  const body = await request.arrayBuffer();

  try {
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

    return new NextResponse(null, { status: upstream.status });
  } catch (error) {
    console.error("Umami send proxy failed:", error);
    return new NextResponse(null, { status: 502 });
  }
}
