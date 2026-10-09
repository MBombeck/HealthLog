import { prisma } from "@/lib/db";
import {
  apiError,
  apiSuccess,
  apiValidationError,
  safeJson,
  sanitiseZodIssues,
} from "@/lib/api-response";
import {
  notificationChannelEnabledSchema,
  webhookSettingsSchemaWith,
} from "@/lib/validations/notifications";
import {
  evaluateNotificationTarget,
  isAllowedNotificationTarget,
  PRIVATE_ORIGIN_NOT_APPROVED_CODE,
  PRIVATE_ORIGIN_NOT_GRANTABLE_CODE,
} from "@/lib/notifications/egress-policy";
import { encrypt, decrypt } from "@/lib/crypto";
import { NextRequest } from "next/server";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import type { WebhookChannelConfig } from "@/lib/notifications/types";

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
const NOT_GRANTABLE_REFUSAL =
  "This address is a link-local, metadata or unspecified address, which no operator grant can open. Use the address the relay actually listens on.";

/**
 * Generic-webhook channel config (v1.17.1).
 * GET: current config (header value redacted — only presence flagged).
 * PUT: upsert config.
 *
 * Covers Discord / Slack / Gotify / Home Assistant / n8n in one channel: the user supplies a URL and an optional shared-secret header. SSRF
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
      format: "generic",
    });
  }

  const config = JSON.parse(
    decrypt(channel.config),
  ) as Partial<WebhookChannelConfig>;

  annotate({ action: { name: "settings.webhook.get" } });

  return apiSuccess({
    enabled: channel.enabled,
    url: config.url ?? "",
    headerName: config.headerName ?? "",
    hasHeaderValue: !!config.headerValue,
    // A config saved before the choice existed carries no format: generic.
    format: config.format === "gotify" ? "gotify" : "generic",
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
    // Every shape refusal carries the issue list; the private-origin case
    // adds the code and a message naming the operator's lever (#947).
    const issues = sanitiseZodIssues(parsed.error.issues);
    const candidate = (body as { url?: unknown } | null)?.url;
    const reason =
      typeof candidate === "string"
        ? evaluateNotificationTarget(candidate).reasonCode
        : null;
    if (
      reason === PRIVATE_ORIGIN_NOT_APPROVED_CODE ||
      reason === PRIVATE_ORIGIN_NOT_GRANTABLE_CODE
    ) {
      annotate({
        action: { name: "settings.webhook.update" },
        meta: { refused: reason },
      });
      return apiValidationError(
        reason === PRIVATE_ORIGIN_NOT_GRANTABLE_CODE
          ? NOT_GRANTABLE_REFUSAL
          : PRIVATE_ORIGIN_REFUSAL,
        issues,
        422,
        { errorCode: reason },
      );
    }
    return apiValidationError("Invalid data", issues, 422);
  }

  const { url, headerName, headerValue, format, enabled } = parsed.data;

  if (enabled && !url) {
    return apiError("Webhook URL is required when the webhook is enabled", 422);
  }

  // Preserve an existing header value when the client sends an empty one (the
  // GET path never returns the secret, so a save round-trip would otherwise
  // wipe it). A non-empty value replaces it. An omitted format keeps the
  // stored one too, so a client that does not know the field cannot flip a
  // Gotify channel back to the generic body by saving.
  let nextHeaderValue = headerValue || undefined;
  let nextFormat = format;
  if (!nextHeaderValue || nextFormat === undefined) {
    const existing = await prisma.notificationChannel.findUnique({
      where: { userId_type: { userId: user.id, type: "WEBHOOK" } },
    });
    if (existing) {
      const prev = JSON.parse(
        decrypt(existing.config),
      ) as Partial<WebhookChannelConfig>;
      if (!nextHeaderValue) nextHeaderValue = prev.headerValue || undefined;
      if (nextFormat === undefined) nextFormat = prev.format;
    }
  }

  // Absent means generic, so only the Gotify choice is written.
  const config = JSON.stringify({
    url: url || "",
    ...(headerName ? { headerName } : {}),
    ...(nextHeaderValue ? { headerValue: nextHeaderValue } : {}),
    ...(nextFormat === "gotify" ? { format: "gotify" } : {}),
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

  annotate({
    action: { name: "settings.webhook.update" },
    meta: { enabled, format: nextFormat === "gotify" ? "gotify" : "generic" },
  });

  return apiSuccess({ saved: true });
});
