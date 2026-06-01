import { safeFetch } from "@/lib/safe-fetch";

interface ParsedGlitchtipDsn {
  dsn: string;
  publicKey: string;
  envelopeUrl: string;
  storeUrl: string;
}

export interface GlitchtipEventPayloadInput {
  environment: string;
  message: string;
  level: "error" | "warning" | "info";
  type?: string;
  stack?: string;
  url?: string;
  userAgent?: string;
  sourceTag: string;
  requestId?: string;
}

export interface GlitchtipDeliveryResult {
  ok: boolean;
  method?: "envelope" | "store-query" | "store-header";
  status?: number;
  details?: string;
}

function createEventId(): string {
  const chars = "abcdef0123456789";
  let out = "";
  for (let i = 0; i < 32; i += 1) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

function parseGlitchtipDsn(dsn: string): ParsedGlitchtipDsn | null {
  try {
    const parsed = new URL(dsn);
    const publicKey = decodeURIComponent(parsed.username || "").trim();
    if (!publicKey) return null;

    const pathParts = parsed.pathname.split("/").filter(Boolean);
    if (pathParts.length === 0) return null;
    const projectId = pathParts[pathParts.length - 1];
    if (!projectId) return null;

    const pathPrefix =
      pathParts.length > 1 ? `/${pathParts.slice(0, -1).join("/")}` : "";

    return {
      dsn,
      publicKey,
      envelopeUrl: `${parsed.protocol}//${parsed.host}${pathPrefix}/api/${projectId}/envelope/`,
      storeUrl: `${parsed.protocol}//${parsed.host}${pathPrefix}/api/${projectId}/store/`,
    };
  } catch {
    return null;
  }
}

function buildEventPayload(
  eventId: string,
  input: GlitchtipEventPayloadInput,
): Record<string, unknown> {
  return {
    event_id: eventId,
    platform: "javascript",
    level: input.level,
    environment: input.environment,
    timestamp: Date.now() / 1000,
    message: input.message,
    exception: {
      values: [
        {
          type: input.type ?? "Error",
          value: input.message,
          stacktrace: input.stack
            ? {
                frames: [
                  {
                    filename: input.url ?? "unknown",
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
    request: input.url ? { url: input.url } : undefined,
    tags: {
      source: input.sourceTag,
      ...(input.requestId ? { request_id: input.requestId } : {}),
    },
    contexts: {
      browser: input.userAgent ? { name: input.userAgent } : undefined,
    },
  };
}

function buildEnvelopeBody(
  config: ParsedGlitchtipDsn,
  eventId: string,
  payload: Record<string, unknown>,
): string {
  const envelopeHeader = JSON.stringify({
    event_id: eventId,
    sent_at: new Date().toISOString(),
    dsn: config.dsn,
  });
  const itemHeader = JSON.stringify({ type: "event" });
  const itemPayload = JSON.stringify(payload);
  return `${envelopeHeader}\n${itemHeader}\n${itemPayload}`;
}

async function tryEnvelope(
  config: ParsedGlitchtipDsn,
  body: string,
): Promise<GlitchtipDeliveryResult> {
  const response = await safeFetch(
    config.envelopeUrl,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-sentry-envelope",
      },
      body,
      cache: "no-store",
    },
    // Operator-configured GlitchTip host carrying the redacted wide-event
    // payload — pin the connect-time IP against DNS rebinding.
    { requirePublicHost: true },
  );

  if (response.ok)
    return { ok: true, method: "envelope", status: response.status };
  const details = await response.text().catch(() => "");
  return {
    ok: false,
    method: "envelope",
    status: response.status,
    details: details || undefined,
  };
}

async function tryStoreQuery(
  config: ParsedGlitchtipDsn,
  payload: Record<string, unknown>,
): Promise<GlitchtipDeliveryResult> {
  const target = new URL(config.storeUrl);
  target.searchParams.set("sentry_key", config.publicKey);
  target.searchParams.set("sentry_version", "7");
  target.searchParams.set("sentry_client", "healthlog/1.0");

  const response = await safeFetch(
    target,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
      cache: "no-store",
    },
    // Operator-configured GlitchTip host — pin the connect-time IP.
    { requirePublicHost: true },
  );

  if (response.ok)
    return { ok: true, method: "store-query", status: response.status };
  const details = await response.text().catch(() => "");
  return {
    ok: false,
    method: "store-query",
    status: response.status,
    details: details || undefined,
  };
}

async function tryStoreHeader(
  config: ParsedGlitchtipDsn,
  payload: Record<string, unknown>,
): Promise<GlitchtipDeliveryResult> {
  const sentryAuth = `Sentry sentry_version=7, sentry_key=${config.publicKey}, sentry_client=healthlog/1.0`;
  const response = await safeFetch(
    config.storeUrl,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-sentry-auth": sentryAuth,
      },
      body: JSON.stringify(payload),
      cache: "no-store",
    },
    // Operator-configured GlitchTip host — pin the connect-time IP.
    { requirePublicHost: true },
  );

  if (response.ok)
    return { ok: true, method: "store-header", status: response.status };
  const details = await response.text().catch(() => "");
  return {
    ok: false,
    method: "store-header",
    status: response.status,
    details: details || undefined,
  };
}

export async function sendGlitchtipEvent(params: {
  dsn: string;
  input: GlitchtipEventPayloadInput;
}): Promise<GlitchtipDeliveryResult> {
  const config = parseGlitchtipDsn(params.dsn);
  if (!config) {
    return { ok: false, details: "invalid_dsn" };
  }

  const eventId = createEventId();
  const payload = buildEventPayload(eventId, params.input);
  const envelopeBody = buildEnvelopeBody(config, eventId, payload);

  const envelopeResult = await tryEnvelope(config, envelopeBody);
  if (envelopeResult.ok) return envelopeResult;

  const storeQueryResult = await tryStoreQuery(config, payload);
  if (storeQueryResult.ok) return storeQueryResult;

  const storeHeaderResult = await tryStoreHeader(config, payload);
  if (storeHeaderResult.ok) return storeHeaderResult;

  return {
    ok: false,
    method: storeHeaderResult.method,
    status:
      storeHeaderResult.status ??
      storeQueryResult.status ??
      envelopeResult.status,
    details:
      storeHeaderResult.details ??
      storeQueryResult.details ??
      envelopeResult.details,
  };
}
