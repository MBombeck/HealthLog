import { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/auth/session";
import { apiError, apiSuccess } from "@/lib/api-response";
import { getPublicMonitoringSettings } from "@/lib/monitoring-settings";

export const dynamic = "force-dynamic";

function resolveUmamiSendUrl(scriptUrl: string | null): string | null {
  if (!scriptUrl) return null;
  try {
    const parsed = new URL(scriptUrl);
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments.length > 0 && segments[segments.length - 1]?.includes(".")) {
      segments.pop();
    }
    const prefix = segments.length > 0 ? `/${segments.join("/")}` : "";
    return `${parsed.origin}${prefix}/api/send`;
  } catch {
    return null;
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
    return new URL(`https://${request.headers.get("host") ?? "localhost:3000"}`);
  }
}

export async function POST(request: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return apiError("Nicht berechtigt", 403);

  const settings = await getPublicMonitoringSettings();
  if (!settings.umamiEnabled) {
    return apiError("Umami ist deaktiviert", 422);
  }
  if (!settings.umamiScriptUrl || !settings.umamiWebsiteId) {
    return apiError(
      "Umami Script-URL und Website-ID müssen konfiguriert sein",
      422,
    );
  }

  const targetUrl = resolveUmamiSendUrl(settings.umamiScriptUrl);
  if (!targetUrl) {
    return apiError("Umami Script-URL ist ungültig", 422);
  }

  const appUrl = resolveAppUrl(request);
  const payload = {
    type: "event",
    payload: {
      website: settings.umamiWebsiteId,
      hostname: appUrl.hostname,
      screen: "1920x1080",
      language: "de-DE",
      title: "HealthLog Monitoring Test",
      url: "/admin",
      referrer: "",
      name: "healthlog_monitoring_test",
      data: {
        source: "admin",
      },
    },
  };

  try {
    const upstream = await fetch(targetUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "healthlog-admin-monitoring-test",
      },
      body: JSON.stringify(payload),
      cache: "no-store",
    });

    if (!upstream.ok) {
      const details = await upstream.text().catch(() => "");
      console.error("Umami test event rejected:", upstream.status, details);
      return apiError(
        `Umami-Testevent wurde abgelehnt (HTTP ${upstream.status})`,
        502,
      );
    }

    return apiSuccess({
      sent: true,
      message: "Umami-Testevent wurde gesendet",
    });
  } catch (error) {
    console.error("Umami test event failed:", error);
    return apiError("Umami ist nicht erreichbar", 502);
  }
}
