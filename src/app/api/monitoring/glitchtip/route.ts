import { NextRequest } from "next/server";
import { z } from "zod/v4";
import {
  apiError,
  apiSuccess,
  apiValidationError,
  getClientIp,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { checkRateLimit } from "@/lib/rate-limit";
import { getGlitchtipSettings } from "@/lib/monitoring-settings";
import { sendGlitchtipEvent } from "@/lib/monitoring/glitchtip";
import { apiHandler } from "@/lib/api-handler";
import { annotate, getEvent } from "@/lib/logging/context";

const clientErrorSchema = z
  .object({
    message: z.string().min(1).max(2000),
    stack: z.string().max(20000).optional(),
    level: z.enum(["error", "warning", "info"]).optional(),
    type: z.string().max(120).optional(),
    url: z.string().max(2000).optional(),
    userAgent: z.string().max(1000).optional(),
  })
  .strict();

export const POST = apiHandler(async (request: NextRequest) => {
  annotate({ action: { name: "monitoring.glitchtip.report" } });

  const ip = getClientIp(request);
  const rl = await checkRateLimit(`glitchtip:${ip}`, 20, 60 * 1000);
  if (!rl.allowed) return apiError("Rate limit exceeded", 429);

  const settings = await getGlitchtipSettings();
  if (!settings.glitchtipEnabled || !settings.glitchtipDsn) {
    return apiSuccess({ skipped: true });
  }

  let body: unknown;
  try {
    const raw = await request.text();
    if (raw.length > 256 * 1024) {
      return apiError(`Request body exceeds ${256 * 1024} bytes`, 413);
    }
    body = JSON.parse(raw);
  } catch {
    return apiError("Invalid JSON data", 422);
  }

  const parsed = clientErrorSchema.safeParse(body);
  if (!parsed.success)
    return apiValidationError(
      "Invalid error data",
      sanitiseZodIssues(parsed.error.issues),
      422,
    );

  const delivery = await sendGlitchtipEvent({
    dsn: settings.glitchtipDsn,
    input: {
      environment: settings.glitchtipEnvironment || "production",
      message: parsed.data.message,
      stack: parsed.data.stack,
      level: parsed.data.level ?? "error",
      type: parsed.data.type,
      url: parsed.data.url,
      userAgent: parsed.data.userAgent,
      sourceTag: "healthlog-client",
    },
  });

  if (!delivery.ok) {
    getEvent()?.addWarning(
      "Glitchtip event rejected: " +
        delivery.method +
        " " +
        delivery.status +
        " " +
        delivery.details,
    );
    return apiError("Glitchtip could not accept error", 502);
  }

  return apiSuccess({ sent: true });
});
