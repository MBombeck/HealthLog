import { NextRequest } from "next/server";
import { z } from "zod/v4";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { checkRateLimit } from "@/lib/rate-limit";
import { getGlitchtipSettings } from "@/lib/monitoring-settings";

const clientErrorSchema = z.object({
  message: z.string().min(1).max(2000),
  stack: z.string().max(20000).optional(),
  level: z.enum(["error", "warning", "info"]).optional(),
  type: z.string().max(120).optional(),
  url: z.string().max(2000).optional(),
  userAgent: z.string().max(1000).optional(),
});

function createEventId(): string {
  const chars = "abcdef0123456789";
  let out = "";
  for (let i = 0; i < 32; i += 1) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

function buildGlitchtipEnvelope(params: {
  dsn: string;
  environment: string;
  message: string;
  stack?: string;
  level: "error" | "warning" | "info";
  type?: string;
  url?: string;
  userAgent?: string;
}) {
  const eventId = createEventId();
  const sentAt = new Date().toISOString();
  const timestamp = Date.now() / 1000;

  const payload = {
    event_id: eventId,
    platform: "javascript",
    level: params.level,
    environment: params.environment,
    timestamp,
    message: params.message,
    exception: {
      values: [
        {
          type: params.type ?? "Error",
          value: params.message,
          stacktrace: params.stack
            ? {
                frames: [
                  {
                    filename: params.url ?? "unknown",
                    function: "<anonymous>",
                    in_app: true,
                    module: "healthlog",
                    lineno: 1,
                    colno: 1,
                  },
                ],
              }
            : undefined,
        },
      ],
    },
    request: params.url ? { url: params.url } : undefined,
    tags: {
      source: "healthlog-client",
    },
    contexts: {
      browser: params.userAgent ? { name: params.userAgent } : undefined,
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

export async function POST(request: NextRequest) {
  const ip = getClientIp(request);
  const rl = checkRateLimit(`glitchtip:${ip}`, 20, 60 * 1000);
  if (!rl.allowed) return apiError("Rate limit exceeded", 429);

  const settings = await getGlitchtipSettings();
  if (!settings.glitchtipEnabled || !settings.glitchtipDsn) {
    return apiSuccess({ skipped: true });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError("Ungültige JSON-Daten", 422);
  }

  const parsed = clientErrorSchema.safeParse(body);
  if (!parsed.success) return apiError("Ungültige Fehlerdaten", 422);

  const envelopeUrl = resolveEnvelopeUrl(settings.glitchtipDsn);
  if (!envelopeUrl) return apiError("Glitchtip DSN ungültig", 422);

  const envelope = buildGlitchtipEnvelope({
    dsn: settings.glitchtipDsn,
    environment: settings.glitchtipEnvironment || "production",
    message: parsed.data.message,
    stack: parsed.data.stack,
    level: parsed.data.level ?? "error",
    type: parsed.data.type,
    url: parsed.data.url,
    userAgent: parsed.data.userAgent,
  });

  try {
    const response = await fetch(envelopeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-sentry-envelope",
      },
      body: envelope,
      cache: "no-store",
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      console.error("Glitchtip envelope rejected:", response.status, bodyText);
      return apiError("Glitchtip konnte Fehler nicht annehmen", 502);
    }

    return apiSuccess({ sent: true });
  } catch (error) {
    console.error("Failed to send event to Glitchtip:", error);
    return apiError("Glitchtip nicht erreichbar", 502);
  }
}
