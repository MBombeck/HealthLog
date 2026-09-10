import { prisma } from "@/lib/db";
import { apiSuccess, apiError, safeJson } from "@/lib/api-response";
import {
  notificationChannelEnabledSchema,
  webhookSettingsSchemaWith,
} from "@/lib/validations/notifications";
import {
  evaluateNotificationTarget,
  isAllowedNotificationTarget,
  PRIVATE_ORIGIN_NOT_APPROVED,
} from "@/lib/notifications/egress-policy";
import { encrypt, decrypt } from "@/lib/crypto";
import { NextRequest } from "next/server";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";

/**
 * The save-time schema evaluates the same policy the sender does: the public
 * floor, plus the operator's exact-origin grant (#947). A listed private
 * address therefore saves; an unlisted one is refused here with the reason,
 * before anything is encrypted onto the row.
 */
const webhookSettingsSchema = webhookSettingsSchemaWith(
  isAllowedNotificationTarget,
);

const PRIVATE_ORIGIN_REFUSAL =
  "This address is on a private network. The operator has to list its exact origin (scheme://host:port) in NOTIFICATION_PRIVATE_ORIGINS before HealthLog can send to it.";

/**
 * Generic-webhook channel config (v1.17.1).
 * GET: current config (header value redacted — only presence flagged).
 * PUT: upsert config.
 *
 * Covers Gotify / Discord / Slack / Matrix-bridge / Home Assistant in one
 * channel: the user supplies a URL and an optional shared-secret header. SSRF
 * is enforced at input time (the schema's target predicate) and again at
 * dispatch time (`safeFetch` with the connect-time pin); a private origin
 * passes both only when the operator listed it in
 * `NOTIFICATION_PRIVATE_ORIGINS`.
 */
export const GET = apiHandler(async () => {
  const { user } = await requireAuth();

  const channel = await prisma.notificationChannel.findUnique({
    where: { userId_type: { userId: user.id, type: "WEBHOOK" } },
  });

  if (!channel) {
    return apiSuccess({
      enabled: false,
      url: "",
      headerName: "",
      hasHeaderValue: false,
    });
  }

  const config = JSON.parse(decrypt(channel.config)) as {
    url: string;
    headerName?: string;
    headerValue?: string;
  };

  annotate({ action: { name: "settings.webhook.get" } });

  return apiSuccess({
    enabled: channel.enabled,
    url: config.url,
    headerName: config.headerName ?? "",
    hasHeaderValue: !!config.headerValue,
  });
});

export const PUT = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: 64 * 1024,
  });

  if (jsonError) return jsonError;

  const enabledOnly = notificationChannelEnabledSchema.safeParse(body);
  if (enabledOnly.success) {
    const { enabled } = enabledOnly.data;

    if (enabled) {
      const existing = await prisma.notificationChannel.findUnique({
        where: { userId_type: { userId: user.id, type: "WEBHOOK" } },
      });

      let hasUrl = false;
      if (existing) {
        try {
          const config = JSON.parse(decrypt(existing.config)) as {
            url?: string;
          };
          hasUrl = !!config.url;
        } catch {
          hasUrl = false;
        }
      }

      if (!hasUrl) {
        return apiError(
          "Webhook URL is required when the webhook is enabled",
          422,
        );
      }
    }

    const result = await prisma.notificationChannel.updateMany({
      where: { userId: user.id, type: "WEBHOOK" },
      data: { enabled },
    });
    if (enabled && result.count === 0) {
      return apiError(
        "Webhook URL is required when the webhook is enabled",
        422,
      );
    }

    annotate({
      action: { name: "settings.webhook.update" },
      meta: { enabled },
    });
    return apiSuccess({ saved: true });
  }

  const parsed = webhookSettingsSchema.safeParse(body);
  if (!parsed.success) {
    const candidate = (body as { url?: unknown } | null)?.url;
    if (
      typeof candidate === "string" &&
      evaluateNotificationTarget(candidate).reasonCode ===
        PRIVATE_ORIGIN_NOT_APPROVED
    ) {
      annotate({
        action: { name: "settings.webhook.update" },
        meta: { refused: PRIVATE_ORIGIN_NOT_APPROVED },
      });
      return apiError(PRIVATE_ORIGIN_REFUSAL, 422, {
        errorCode: PRIVATE_ORIGIN_NOT_APPROVED,
      });
    }
    return apiError("Invalid data", 422);
  }

  const { url, headerName, headerValue, enabled } = parsed.data;

  if (enabled && !url) {
    return apiError("Webhook URL is required when the webhook is enabled", 422);
  }

  // Preserve an existing header value when the client sends an empty one (the
  // GET path never returns the secret, so a save round-trip would otherwise
  // wipe it). A non-empty value replaces it.
  let nextHeaderValue = headerValue || undefined;
  if (!nextHeaderValue) {
    const existing = await prisma.notificationChannel.findUnique({
      where: { userId_type: { userId: user.id, type: "WEBHOOK" } },
    });
    if (existing) {
      const prev = JSON.parse(decrypt(existing.config)) as {
        headerValue?: string;
      };
      nextHeaderValue = prev.headerValue || undefined;
    }
  }

  const config = JSON.stringify({
    url: url || "",
    ...(headerName ? { headerName } : {}),
    ...(nextHeaderValue ? { headerValue: nextHeaderValue } : {}),
  });

  const encryptedConfig = encrypt(config);

  await prisma.notificationChannel.upsert({
    where: { userId_type: { userId: user.id, type: "WEBHOOK" } },
    create: {
      userId: user.id,
      type: "WEBHOOK",
      enabled,
      config: encryptedConfig,
    },
    update: { enabled, config: encryptedConfig },
  });

  annotate({ action: { name: "settings.webhook.update" }, meta: { enabled } });

  return apiSuccess({ saved: true });
});
