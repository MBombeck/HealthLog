import { NextResponse } from "next/server";
import { getPublicMonitoringSettings } from "@/lib/monitoring-settings";

export const dynamic = "force-dynamic";

const NOOP_SCRIPT = "/* umami disabled */";

export async function GET() {
  const settings = await getPublicMonitoringSettings();
  if (!settings.umamiEnabled || !settings.umamiScriptUrl || !settings.umamiWebsiteId) {
    return new NextResponse(NOOP_SCRIPT, {
      status: 200,
      headers: {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "public, max-age=60",
      },
    });
  }

  try {
    const response = await fetch(settings.umamiScriptUrl, {
      next: { revalidate: 3600 },
    });
    if (!response.ok) {
      return new NextResponse(NOOP_SCRIPT, {
        status: 200,
        headers: {
          "Content-Type": "application/javascript; charset=utf-8",
          "Cache-Control": "public, max-age=60",
        },
      });
    }

    const script = await response.text();
    return new NextResponse(script, {
      status: 200,
      headers: {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "public, max-age=1800",
      },
    });
  } catch (error) {
    console.error("Failed to load Umami script:", error);
    return new NextResponse(NOOP_SCRIPT, {
      status: 200,
      headers: {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "public, max-age=60",
      },
    });
  }
}
