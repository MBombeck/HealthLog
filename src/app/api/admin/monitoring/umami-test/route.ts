import { NextRequest } from "next/server";
import { apiHandler, requireAdmin } from "@/lib/api-handler";
import { annotate, getEvent } from "@/lib/logging/context";
import { apiError, apiSuccess } from "@/lib/api-response";
import { getPublicMonitoringSettings } from "@/lib/monitoring-settings";

export const dynamic = "force-dynamic";

function redact(text: string): string {
  return text.replace(/https?:\/\/\S+/gi, "[url]");
}

function resolveUmamiSendUrls(scriptUrl: string | null): string[] {
  if (!scriptUrl) return [];
  try {
    const parsed = new URL(scriptUrl);
    const origin = parsed.origin;
    const pathSegments = parsed.pathname.split("/").filter(Boolean);
    const segments = [...pathSegments];

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

function resolveAppUrl(request: NextRequest): URL {
  const configured =
    process.env.APP_URL ??
    process.env.NEXT_PUBLIC_APP_URL ??
    `https://${request.headers.get("host") ?? "localhost:3000"}`;

  try {
    return new URL(configured);
  } catch {
    return new URL(
      `https://${request.headers.get("host") ?? "localhost:3000"}`,
    );
  }
}

export const POST = apiHandler(async (request: NextRequest) => {
  await requireAdmin();
  annotate({ action: { name: "admin.monitoring.umami-test" } });

  const settings = await getPublicMonitoringSettings();
  if (!settings.umamiEnabled) {
    return apiError("Umami is disabled", 422);
  }
  if (!settings.umamiScriptUrl || !settings.umamiWebsiteId) {
    return apiError("Umami script URL and website ID must be configured", 422);
  }

  const targetUrls = resolveUmamiSendUrls(settings.umamiScriptUrl);
  if (targetUrls.length === 0) {
    return apiError("Umami script URL is invalid", 422);
  }

  const appUrl = resolveAppUrl(request);
  const payload = {
    type: "event",
    payload: {
      website: settings.umamiWebsiteId,
      hostname: appUrl.hostname,
      screen: "1920x1080",
      language: "en-US",
      title: "HealthLog Monitoring Test",
      url: "/admin",
      referrer: "",
      name: "healthlog_monitoring_test",
      data: {
        source: "admin",
      },
    },
  };

  let lastStatus = 404;
  let lastDetails = "";

  for (const targetUrl of targetUrls) {
    const upstream = await fetch(targetUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "healthlog-admin-monitoring-test",
      },
      body: JSON.stringify(payload),
      cache: "no-store",
    });

    if (upstream.ok) {
      return apiSuccess({
        sent: true,
        message: "Umami test event sent",
      });
    }

    lastStatus = upstream.status;
    lastDetails = await upstream.text().catch(() => "");

    // Try next candidate only for path misses.
    if (upstream.status === 404) {
      continue;
    }

    break;
  }

  getEvent()?.addWarning(
    `Umami test event rejected: ${lastStatus}${lastDetails ? ` ${redact(lastDetails)}` : ""}`,
  );
  return apiError(`Umami test event rejected (HTTP ${lastStatus})`, 502);
});
