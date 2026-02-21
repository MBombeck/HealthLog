import { requireAdmin } from "@/lib/auth/session";
import { apiError, apiSuccess } from "@/lib/api-response";
import { getGlitchtipSettings } from "@/lib/monitoring-settings";

export const dynamic = "force-dynamic";

function createEventId(): string {
  const chars = "abcdef0123456789";
  let out = "";
  for (let i = 0; i < 32; i += 1) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

function resolveEnvelopeUrl(dsn: string): string | null {
  try {
    const parsed = new URL(dsn);
    const pathParts = parsed.pathname.split("/").filter(Boolean);
    if (pathParts.length === 0) return null;
    const projectId = pathParts[pathParts.length - 1];
    if (!projectId) return null;
    const pathPrefix =
      pathParts.length > 1 ? `/${pathParts.slice(0, -1).join("/")}` : "";
    return `${parsed.protocol}//${parsed.host}${pathPrefix}/api/${projectId}/envelope/`;
  } catch {
    return null;
  }
}

function buildEnvelope(params: {
  dsn: string;
  environment: string;
  message: string;
}) {
  const eventId = createEventId();
  const sentAt = new Date().toISOString();
  const timestamp = Date.now() / 1000;

  const payload = {
    event_id: eventId,
    platform: "javascript",
    level: "error",
    environment: params.environment,
    timestamp,
    message: params.message,
    exception: {
      values: [
        {
          type: "HealthLogMonitoringTest",
          value: params.message,
        },
      ],
    },
    tags: {
      source: "healthlog-admin-test",
    },
  };

  const envelopeHeader = JSON.stringify({
    event_id: eventId,
    sent_at: sentAt,
    dsn: params.dsn,
  });
  const itemHeader = JSON.stringify({ type: "event" });
  const itemPayload = JSON.stringify(payload);

  return `${envelopeHeader}\n${itemHeader}\n${itemPayload}`;
}

export async function POST() {
  const admin = await requireAdmin();
  if (!admin) return apiError("Nicht berechtigt", 403);

  const settings = await getGlitchtipSettings();
  if (!settings.glitchtipEnabled) {
    return apiError("Glitchtip ist deaktiviert", 422);
  }
  if (!settings.glitchtipDsn) {
    return apiError("Glitchtip DSN fehlt", 422);
  }

  const envelopeUrl = resolveEnvelopeUrl(settings.glitchtipDsn);
  if (!envelopeUrl) {
    return apiError("Glitchtip DSN ist ungültig", 422);
  }

  const envelope = buildEnvelope({
    dsn: settings.glitchtipDsn,
    environment: settings.glitchtipEnvironment || "production",
    message: "HealthLog Monitoring Test",
  });

  try {
    const response = await fetch(envelopeUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-sentry-envelope",
      },
      body: envelope,
      cache: "no-store",
    });

    if (!response.ok) {
      const details = await response.text().catch(() => "");
      console.error("Glitchtip test event rejected:", response.status, details);
      return apiError(
        `Glitchtip-Testevent wurde abgelehnt (HTTP ${response.status})`,
        502,
      );
    }

    return apiSuccess({
      sent: true,
      message: "Glitchtip-Testevent wurde gesendet",
    });
  } catch (error) {
    console.error("Glitchtip test event failed:", error);
    return apiError("Glitchtip ist nicht erreichbar", 502);
  }
}
