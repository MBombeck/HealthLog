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
  ntfySettingsSchemaWith,
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
import { isChannelGloballyEnabled } from "@/lib/app-settings";
import { annotate } from "@/lib/logging/context";

/**
 * The save-time schema evaluates the same policy the sender does: the public
 * floor, plus the operator's exact-origin grant (#947). A listed private
 * server therefore saves; an unlisted one is refused here with the reason.
 */
const ntfySettingsSchema = ntfySettingsSchemaWith(isAllowedNotificationTarget);

const PRIVATE_ORIGIN_REFUSAL =
  "This server is on a private network. The operator has to list its exact origin (scheme://host:port) in NOTIFICATION_PRIVATE_ORIGINS before HealthLog can send to it.";
const NOT_GRANTABLE_REFUSAL =
  "This server is loopback, link-local or a metadata address, which no operator grant can open. Use the relay's LAN address instead.";

/**
 * Refusal for an enable attempt on a channel the operator switched off
 * instance-wide (`AppSettings.ntfyGlobal`). A toggle that appeared to work
 * and then delivered nothing is worse than a refusal that says why.
 */
const NTFY_GLOBALLY_DISABLED =
  "ntfy is disabled on this instance by the operator";

/**
 * GET: Return current ntfy config (without auth token).
 * PUT: Update ntfy config.
 */
export const GET = apiHandler(async () => {
  const { user } = await requireAuth();

  const channel = await prisma.notificationChannel.findUnique({
    where: {
      userId_type: { userId: user.id, type: "NTFY" },
    },
  });

  if (!channel) {
    return apiSuccess({
      enabled: false,
      serverUrl: "https://ntfy.sh",
      topic: "",
      hasAuthToken: false,
    });
  }

  const config = JSON.parse(decrypt(channel.config)) as {
    serverUrl: string;
    topic: string;
    authToken?: string;
  };

  annotate({ action: { name: "settings.ntfy.get" } });

  return apiSuccess({
    enabled: channel.enabled,
    serverUrl: config.serverUrl,
    topic: config.topic,
    hasAuthToken: !!config.authToken,
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

    if (enabled && !(await isChannelGloballyEnabled("NTFY"))) {
      annotate({
        action: { name: "settings.ntfy.update" },
        meta: { refused: "globally_disabled" },
      });
      return apiError(NTFY_GLOBALLY_DISABLED, 403);
    }

    if (enabled) {
      const existing = await prisma.notificationChannel.findUnique({
        where: { userId_type: { userId: user.id, type: "NTFY" } },
      });

      let isConfigured = false;
      if (existing) {
        try {
          const config = JSON.parse(decrypt(existing.config)) as {
            serverUrl?: string;
            topic?: string;
          };
          isConfigured = !!config.serverUrl && !!config.topic;
        } catch {
          isConfigured = false;
        }
      }

      if (!isConfigured) {
        return apiError(
          "Server URL and topic are required when ntfy is enabled",
          422,
        );
      }
    }

    const result = await prisma.notificationChannel.updateMany({
      where: { userId: user.id, type: "NTFY" },
      data: { enabled },
    });
    if (enabled && result.count === 0) {
      return apiError(
        "Server URL and topic are required when ntfy is enabled",
        422,
      );
    }

    annotate({ action: { name: "settings.ntfy.update" }, meta: { enabled } });
    return apiSuccess({ saved: true });
  }

  const parsed = ntfySettingsSchema.safeParse(body);
  if (!parsed.success) {
    // Every shape refusal carries the issue list; the private-origin case
    // adds the code and a message naming the operator's lever (#947).
    const issues = sanitiseZodIssues(parsed.error.issues);
    const candidate = (body as { serverUrl?: unknown } | null)?.serverUrl;
    const reason =
      typeof candidate === "string"
        ? evaluateNotificationTarget(candidate).reasonCode
        : null;
    if (
      reason === PRIVATE_ORIGIN_NOT_APPROVED_CODE ||
      reason === PRIVATE_ORIGIN_NOT_GRANTABLE_CODE
    ) {
      annotate({
        action: { name: "settings.ntfy.update" },
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

  const { serverUrl, topic, authToken, enabled } = parsed.data;

  if (enabled && !(await isChannelGloballyEnabled("NTFY"))) {
    annotate({
      action: { name: "settings.ntfy.update" },
      meta: { refused: "globally_disabled" },
    });
    return apiError(NTFY_GLOBALLY_DISABLED, 403);
  }

  if (enabled && (!serverUrl || !topic)) {
    return apiError(
      "Server URL and topic are required when ntfy is enabled",
      422,
    );
  }

  // v1.32.1 — preserve an existing auth token when the client sends an
  // empty one (issue #63). GET never returns the secret (`hasAuthToken`
  // only), so both native and web clients correctly omit — or round-trip
  // an empty string through — the field on any unrelated edit (e.g.
  // toggling `enabled`). Reconstructing `config` from scratch without this
  // fallback silently dropped the token on every such save. Mirrors the
  // identical `headerValue` preserve-on-empty contract in
  // `src/app/api/settings/webhook/route.ts`. A non-empty value replaces it.
  let nextAuthToken = authToken || undefined;
  if (!nextAuthToken) {
    const existing = await prisma.notificationChannel.findUnique({
      where: { userId_type: { userId: user.id, type: "NTFY" } },
    });
    if (existing) {
      const prev = JSON.parse(decrypt(existing.config)) as {
        authToken?: string;
      };
      nextAuthToken = prev.authToken || undefined;
    }
  }

  const config = JSON.stringify({
    serverUrl: serverUrl || "https://ntfy.sh",
    topic: topic || "",
    ...(nextAuthToken ? { authToken: nextAuthToken } : {}),
  });

  const encryptedConfig = encrypt(config);

  await prisma.notificationChannel.upsert({
    where: {
      userId_type: { userId: user.id, type: "NTFY" },
    },
    create: {
      userId: user.id,
      type: "NTFY",
      enabled,
      config: encryptedConfig,
    },
    update: {
      enabled,
      config: encryptedConfig,
    },
  });

  annotate({ action: { name: "settings.ntfy.update" }, meta: { enabled } });

  return apiSuccess({ saved: true });
});
